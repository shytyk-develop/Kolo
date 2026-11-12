# imports aiogram (~1 s): load only where Telegram is needed

from __future__ import annotations

from collections.abc import Callable
from urllib.parse import urlencode

from aiogram import Bot
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.types import CopyTextButton, InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo

from .config import Settings
from .signing import sign
from .texts import plain, t

BotFactory = Callable[[Settings], Bot]

# longer names push the other button off the row
BUTTON_NAME_MAX = 24


def make_bot(settings: Settings) -> Bot:
    # one per request: serverless event loops don't live long
    return Bot(
        settings.bot_token,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML, link_preview_is_disabled=True),
    )


def room_url(settings: Settings, code: str) -> str:
    return f"{settings.kolo_url}/r/{code}"


def open_url(settings: Settings, url: str, lang: str) -> str:
    query = urlencode({"u": url, "s": sign(settings.api_key, url), "l": lang})
    return f"{settings.public_url}/open?{query}"


def _short(name: str) -> str:
    return name if len(name) <= BUTTON_NAME_MAX else name[: BUTTON_NAME_MAX - 1] + "…"


def invite_view(
    settings: Settings, lang: str, *, invite_id: str, caller_name: str, room: str, known: bool
) -> tuple[str, InlineKeyboardMarkup]:
    if not known:
        text = t(lang, "invite_unknown", name=caller_name)
        keyboard = [[
            InlineKeyboardButton(text=plain(lang, "btn_accept"), callback_data=f"acc:{invite_id}"),
            InlineKeyboardButton(
                text=plain(lang, "btn_block", name=_short(caller_name)), callback_data=f"blk:{invite_id}"
            ),
        ]]
        return text, InlineKeyboardMarkup(inline_keyboard=keyboard)

    url = room_url(settings, room)
    text = t(lang, "invite", name=caller_name, code=room)
    keyboard = [
        [InlineKeyboardButton(text=plain(lang, "btn_join"), web_app=WebAppInfo(url=open_url(settings, url, lang)))],
        [
            InlineKeyboardButton(text=plain(lang, "btn_open"), url=url),
            InlineKeyboardButton(text=plain(lang, "btn_copy"), copy_text=CopyTextButton(text=url)),
        ],
    ]
    return text, InlineKeyboardMarkup(inline_keyboard=keyboard)
