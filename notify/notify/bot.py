from __future__ import annotations

import contextlib
from functools import cache

from aiogram import Bot, Dispatcher, F, Router
from aiogram.exceptions import TelegramAPIError
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message
from aiogram.types import User as TgUser

from .config import Settings
from .handles import handle_problem, normalize_handle
from .logs import log
from .store import Store
from .telegram import invite_view, linked_view
from .texts import pick_lang, plain, t

router = Router(name="kolo")
# quiet in groups
router.message.filter(F.chat.type == "private")


def _who(user: TgUser | None) -> tuple[str, str]:
    if user is None:
        return "", pick_lang(None)
    return user.full_name.strip()[:64], pick_lang(user.language_code)


@router.message(CommandStart())
async def on_start(message: Message, command: CommandObject, store: Store, settings: Settings) -> None:
    name, lang = _who(message.from_user)
    chat = message.chat.id
    payload = command.args or ""
    token = payload.removeprefix("link_") if payload.startswith("link_") else None
    me = await store.user_by_chat(chat)

    if me is not None:
        await store.touch_user(chat, name, lang)
        await store.clear_state(chat)
        if token is None:
            await message.answer(t(lang, "id_show", handle=me.handle))
        elif await store.bind_link_token(token, me.handle):
            log("linked", new_user=False)
            text, keyboard = linked_view(settings, lang, me.handle, token)
            await message.answer(text, reply_markup=keyboard)
        else:
            await message.answer(t(lang, "link_bad"))
        return

    if token is not None and not await store.link_token_open(token):
        await message.answer(t(lang, "link_bad"))
        token = None
    # binds once they pick an ID
    await store.set_state(chat, "choose", token)
    await message.answer(t(lang, "greet") + "\n" + t(lang, "ask_id"))


@router.message(Command("id"))
async def on_id(message: Message, store: Store) -> None:
    _, lang = _who(message.from_user)
    me = await store.user_by_chat(message.chat.id)
    if me is not None:
        await message.answer(t(lang, "id_show", handle=me.handle))
        return
    await store.set_state(message.chat.id, "choose")
    await message.answer(t(lang, "no_id") + "\n" + t(lang, "ask_id"))


@router.message(Command("rename"))
async def on_rename(message: Message, store: Store) -> None:
    _, lang = _who(message.from_user)
    me = await store.user_by_chat(message.chat.id)
    if me is None:
        await store.set_state(message.chat.id, "choose")
        await message.answer(t(lang, "no_id") + "\n" + t(lang, "ask_id"))
        return
    await store.set_state(message.chat.id, "rename")
    await message.answer(t(lang, "rename_ask", handle=me.handle))


@router.message(Command("stop"))
async def on_stop(message: Message, store: Store) -> None:
    _, lang = _who(message.from_user)
    if await store.user_by_chat(message.chat.id) is None:
        await store.clear_state(message.chat.id)
        await message.answer(t(lang, "stop_nothing"))
        return
    keyboard = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text=plain(lang, "btn_stop_yes"), callback_data="stop:yes"),
        InlineKeyboardButton(text=plain(lang, "btn_stop_no"), callback_data="stop:no"),
    ]])
    await message.answer(t(lang, "stop_ask"), reply_markup=keyboard)


@router.message(F.text.startswith("/"))
async def on_other_command(message: Message, store: Store) -> None:
    _, lang = _who(message.from_user)
    me = await store.user_by_chat(message.chat.id)
    await message.answer(t(lang, "hint") if me else t(lang, "need_start"))


@router.message(F.text)
async def on_text(message: Message, store: Store, settings: Settings) -> None:
    # the reply to "which ID?" (first time or /rename)
    name, lang = _who(message.from_user)
    chat = message.chat.id
    state = await store.state(chat)
    me = await store.user_by_chat(chat)
    if state is None:
        await message.answer(t(lang, "hint") if me else t(lang, "need_start"))
        return

    handle = normalize_handle(message.text or "")
    problem = handle_problem(handle)
    if problem is not None:
        await message.answer(t(lang, "id_invalid" if problem == "format" else "id_reserved", handle=handle))
        return

    if me is None:
        if not await store.create_user(handle, chat, name, lang):
            await message.answer(t(lang, "id_taken", handle=handle))
            return
        token = state.link_token
        linked = token is not None and await store.bind_link_token(token, handle)
        await store.clear_state(chat)
        log("user_created", linked=linked)
        if linked and token is not None:
            text, keyboard = linked_view(settings, lang, handle, token)
            await message.answer(text, reply_markup=keyboard)
        else:
            await message.answer(t(lang, "id_saved", handle=handle))
        return

    if handle != me.handle and not await store.rename_user(chat, handle):
        await message.answer(t(lang, "id_taken", handle=handle))
        return
    await store.clear_state(chat)
    log("user_renamed")
    await message.answer(t(lang, "renamed", handle=handle))


async def _edit(
    bot: Bot, chat_id: int, message_id: int, text: str, keyboard: InlineKeyboardMarkup | None = None
) -> None:
    # pressed twice or message gone: same outcome
    with contextlib.suppress(TelegramAPIError):
        await bot.edit_message_text(text=text, chat_id=chat_id, message_id=message_id, reply_markup=keyboard)


@router.callback_query()
async def on_button(callback: CallbackQuery, bot: Bot, store: Store, settings: Settings) -> None:
    note = ""
    try:
        note = await _press(callback, bot, store, settings)
    finally:
        # always, or the button keeps spinning
        with contextlib.suppress(TelegramAPIError):
            await callback.answer(note or None)


async def _press(callback: CallbackQuery, bot: Bot, store: Store, settings: Settings) -> str:
    # every branch is safe to repeat
    message = callback.message
    if message is None:
        return ""
    chat, message_id = message.chat.id, message.message_id
    me = await store.user_by_chat(chat)
    lang = me.lang if me else pick_lang(callback.from_user.language_code)
    kind, _, arg = (callback.data or "").partition(":")

    if kind == "stop":
        if arg == "yes":
            await store.delete_chat(chat)
            log("user_deleted", via="bot")
            await _edit(bot, chat, message_id, t(lang, "stopped"))
        else:
            await _edit(bot, chat, message_id, t(lang, "stop_cancelled"))
        return ""

    if kind not in ("acc", "blk"):
        return ""
    invite = await store.invite(arg)
    # only the recipient
    if invite is None or me is None or invite.chat_id != chat:
        await _edit(bot, chat, message_id, t(lang, "cb_gone"))
        return plain(lang, "cb_gone")
    if invite.status == "ended":
        await _edit(bot, chat, message_id, t(lang, "ended", name=invite.caller_name))
        return plain(lang, "cb_ended")

    if kind == "acc" and invite.status != "blocked":
        await store.add_pair(invite.caller, me.handle)
        await store.set_invite(invite.id, "sent")
        text, keyboard = invite_view(
            settings, lang, invite_id=str(invite.id), caller_name=invite.caller_name, room=invite.room, known=True
        )
        await _edit(bot, chat, message_id, text, keyboard)
        log("invite_accepted", invite_id=invite.id)
        return plain(lang, "cb_accepted")

    await store.add_block(me.handle, invite.caller)
    await store.set_invite(invite.id, "blocked")
    await _edit(bot, chat, message_id, t(lang, "blocked", name=invite.caller_name))
    log("invite_blocked", invite_id=invite.id)
    return plain(lang, "cb_blocked")


@cache
def dispatcher() -> Dispatcher:
    dp = Dispatcher()
    dp.include_router(router)
    return dp
