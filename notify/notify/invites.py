from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING

from .logs import log, log_error, log_warning
from .store import Limit, Store
from .texts import FALLBACK, t

if TYPE_CHECKING:
    from .config import Settings
    from .telegram import BotFactory


@dataclass(frozen=True, slots=True)
class InviteRequest:
    caller: str
    caller_name: str
    target: str
    room: str


class CallerUnknown(Exception):
    pass


class RateLimited(Exception):
    def __init__(self, limit: Limit) -> None:
        super().__init__(limit.reason)
        self.limit = limit


# Telegram error, raised for known pairs only
class DeliveryFailed(Exception):
    pass


async def send_invite(
    store: Store, settings: Settings, make_bot: BotFactory, req: InviteRequest
) -> tuple[uuid.UUID, str]:
    async with store.transaction():
        await store.lock_caller(req.caller)
        if await store.user(req.caller) is None:
            raise CallerUnknown
        known = await store.is_known(req.caller, req.target)
        limit = await store.invite_limit(req.caller, req.target, known)
        if limit is not None:
            log("invite_limited", reason=limit.reason)
            raise RateLimited(limit)
        target = await store.user(req.target)
        blocked = target is not None and await store.is_blocked(req.target, req.caller)
        deliver = target is not None and not blocked
        invite_id = await store.insert_invite(
            req.caller, req.caller_name, req.target, req.room, known, "queued" if deliver else "void"
        )

    # depends only on "called before", so nothing leaks about the target
    answer = "sent" if known else "needs_acceptance"
    if not deliver or target is None:
        log("invite", invite_id=invite_id, known=known, delivered=False)
        return invite_id, answer

    from aiogram.exceptions import TelegramAPIError, TelegramForbiddenError

    from .telegram import invite_view

    text, keyboard = invite_view(
        settings, target.lang, invite_id=str(invite_id), caller_name=req.caller_name, room=req.room, known=known
    )
    try:
        async with make_bot(settings) as bot:
            message = await bot.send_message(target.chat_id, text, reply_markup=keyboard)
    except TelegramForbiddenError:
        # bot blocked or account deleted
        await store.mark_bot_blocked(target.handle)
        await store.set_invite(invite_id, "undeliverable")
        log("invite", invite_id=invite_id, known=known, delivered=False, reason="bot_blocked")
        return invite_id, "undeliverable" if known else answer
    except TelegramAPIError:
        await store.set_invite(invite_id, "failed")
        log_error("invite_failed", invite_id=invite_id)
        if known:
            raise DeliveryFailed from None
        return invite_id, answer

    await store.set_invite(invite_id, answer, chat_id=target.chat_id, message_id=message.message_id)
    log("invite", invite_id=invite_id, known=known, delivered=True)
    return invite_id, answer


async def end_invite(store: Store, settings: Settings, make_bot: BotFactory, invite_id: uuid.UUID) -> bool:
    # False if there's no such invite
    invite = await store.invite(invite_id)
    if invite is None:
        return False
    if invite.status != "ended":
        await store.set_invite(invite.id, "ended")
    if invite.chat_id is None or invite.message_id is None or invite.status in ("ended", "blocked"):
        return True

    from aiogram.exceptions import TelegramAPIError

    who = await store.user_by_chat(invite.chat_id)
    lang = who.lang if who else FALLBACK
    try:
        async with make_bot(settings) as bot:
            await bot.edit_message_text(
                text=t(lang, "ended", name=invite.caller_name), chat_id=invite.chat_id, message_id=invite.message_id
            )
    except TelegramAPIError:
        # message gone or too old: ended anyway
        log_warning("invite_end_edit_failed", invite_id=invite.id)
    log("invite_ended", invite_id=invite.id)
    return True
