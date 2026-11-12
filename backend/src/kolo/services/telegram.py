"""Telegram invites: linking a browser to a Kolo ID, inviting by ID, telling notify how calls went."""

import asyncio
from collections.abc import Coroutine
from datetime import UTC, datetime
from typing import Any

from kolo.core.logging import log
from kolo.core.tg_cookie import HANDLE_RE, Linked
from kolo.domain.errors import InvalidInput
from kolo.domain.models import Peer
from kolo.repositories.base import RoomRepository
from kolo.services.notify import NotifyClient
from kolo.services.rooms import RoomService

NAME_MAX = 40


def normalize_handle(raw: str) -> str:
    return raw.strip().removeprefix("@").lower()


class TelegramService:
    def __init__(self, notify: NotifyClient, rooms: RoomService, repo: RoomRepository) -> None:
        self._notify = notify
        self._rooms = rooms
        self._repo = repo
        self._tasks: set[asyncio.Task] = set()

    async def aclose(self) -> None:
        # let the last "ended" / "completed" calls finish
        if self._tasks:
            await asyncio.wait(self._tasks, timeout=5)
        await self._notify.aclose()

    async def start_link(self) -> dict:
        return await self._notify.create_link()

    async def link_status(self, token: str) -> dict:
        return await self._notify.link_status(token)

    async def unlink(self, handle: str) -> None:
        await self._notify.delete_user(handle)

    async def invite(self, code: str, caller: Linked, raw_target: str) -> str:
        room = await self._rooms.get_room(code)
        target = normalize_handle(raw_target)
        if not HANDLE_RE.fullmatch(target):
            raise InvalidInput("A Kolo ID is 3-20 characters: a-z, 0-9 and _")
        if target == caller.handle:
            raise InvalidInput("That's your own Kolo ID")
        name = " ".join(caller.name.split())[:NAME_MAX] or caller.handle
        result = await self._notify.invite(
            caller=caller.handle, caller_name=name, target=target, room=room.code
        )
        await self._repo.add_invite(room.code, result["invite_id"])
        log.info("telegram_invite", room=room.code, status=result["status"])
        return result["status"]

    def call_ended(self, room_code: str, left: Peer, others: list[Peer]) -> None:
        """Someone left while others stayed: their call is over. Never blocks the leave."""
        for other in others:
            if left.handle and other.handle and other.handle != left.handle:
                self._spawn(self._notify.calls_completed(left.handle, other.handle))
        self._spawn(self._end_invites(room_code))

    async def end_expired_invites(self) -> None:
        for invite_id in await self._repo.take_expired_invites(datetime.now(UTC)):
            await self._quietly(self._notify.invite_ended(invite_id))

    async def _end_invites(self, room_code: str) -> None:
        for invite_id in await self._repo.take_invites(room_code):
            await self._quietly(self._notify.invite_ended(invite_id))

    async def _quietly(self, call: Coroutine[Any, Any, None]) -> None:
        try:
            await call
        except Exception as exc:
            log.warning("telegram_background_failed", error=type(exc).__name__)

    def _spawn(self, call: Coroutine[Any, Any, None]) -> None:
        task = asyncio.create_task(self._quietly(call))
        # keep a ref, or gc can kill the task halfway
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
