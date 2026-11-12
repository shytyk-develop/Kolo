# src/kolo/repositories/memory.py

from dataclasses import replace
from datetime import datetime

from kolo.domain.errors import RoomCodeTaken
from kolo.domain.models import Room


class InMemoryRoomRepository:
    def __init__(self) -> None:
        self._rooms: dict[str, Room] = {}
        self._invites: dict[str, list[str]] = {}

    async def add(self, room: Room) -> None:
        if room.code in self._rooms:
            raise RoomCodeTaken()
        self._rooms[room.code] = room

    async def get_by_code(self, code: str) -> Room | None:
        return self._rooms.get(code)

    async def set_lobby(self, code: str, enabled: bool) -> Room | None:
        room = self._rooms.get(code)
        if room is None:
            return None
        self._rooms[code] = replace(room, lobby_enabled=enabled)
        return self._rooms[code]
    async def add_invite(self, code: str, invite_id: str) -> None:
        self._invites.setdefault(code, []).append(invite_id)

    async def take_invites(self, code: str) -> list[str]:
        return self._invites.pop(code, [])

    async def take_expired_invites(self, now: datetime) -> list[str]:
        gone = [c for c in self._invites if c not in self._rooms or self._rooms[c].is_expired(now)]
        return [invite for code in gone for invite in self._invites.pop(code)]
