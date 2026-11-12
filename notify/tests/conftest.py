# DB: NOTIFY_TEST_DATABASE_URL (gets wiped), else a temp initdb cluster, else skip

from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
from collections.abc import AsyncIterator, Iterator
from typing import Any

import httpx
import pytest
from aiogram import Bot
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.base import BaseSession
from aiogram.enums import ParseMode
from aiogram.methods import TelegramMethod

from notify.app import create_app
from notify.config import Settings
from notify.migrate import migrate
from notify.store import Store, connect

API_KEY = "test-api-key-0123456789abcdef"
SECRET = "test-webhook-secret-0123"
BOT_TOKEN = "42:TEST-TOKEN"


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def settings(pg_url: str) -> Settings:
    return Settings(
        bot_token=BOT_TOKEN,
        bot_username="kolo_test_bot",
        webhook_secret=SECRET,
        api_key=API_KEY,
        database_url=pg_url,
        public_url="https://notify.example",
        kolo_url="https://kolo-black.vercel.app",
    )


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def pg_url() -> Iterator[str]:
    url = os.environ.get("NOTIFY_TEST_DATABASE_URL")
    if url:
        yield url
        return
    initdb, pg_ctl = shutil.which("initdb"), shutil.which("pg_ctl")
    if not (initdb and pg_ctl):
        pytest.skip("no Postgres: set NOTIFY_TEST_DATABASE_URL or put initdb/pg_ctl on PATH")
    root = tempfile.mkdtemp(prefix="notify-pg-")
    data, port = os.path.join(root, "data"), _free_port()
    subprocess.run([initdb, "-D", data, "-U", "postgres", "-A", "trust", "--no-sync"], check=True, capture_output=True)
    opts = f"-p {port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off"
    subprocess.run([pg_ctl, "-D", data, "-o", opts, "-l", os.path.join(root, "log"), "-w", "start"], check=True,
                   capture_output=True)
    try:
        yield f"postgresql://postgres@127.0.0.1:{port}/postgres"
    finally:
        subprocess.run([pg_ctl, "-D", data, "-m", "immediate", "stop"], capture_output=True)
        shutil.rmtree(root, ignore_errors=True)


@pytest.fixture(scope="session")
def migrated(pg_url: str) -> str:
    async def reset() -> None:
        conn = await connect(pg_url)
        try:
            await conn.execute("drop schema public cascade; create schema public;")
        finally:
            await conn.close()
        await migrate(pg_url)

    asyncio.run(reset())
    return pg_url


TABLES = "invites, blocks, known_pairs, link_tokens, chat_states, users"


@pytest.fixture
async def store(migrated: str) -> AsyncIterator[Store]:
    conn = await connect(migrated)
    await conn.execute(f"truncate {TABLES}")
    try:
        yield Store(conn)
    finally:
        await conn.close()


class FakeSession(BaseSession):
    def __init__(self) -> None:
        super().__init__()
        self.calls: list[TelegramMethod[Any]] = []
        # sendMessage to these gets 403
        self.blocked_chats: set[int] = set()
        # every call fails with 500
        self.down = False
        self._next_id = 100

    async def close(self) -> None:
        pass

    async def stream_content(self, *args: Any, **kwargs: Any) -> AsyncIterator[bytes]:  # pragma: no cover
        raise NotImplementedError
        yield b""

    async def make_request(self, bot: Bot, method: TelegramMethod[Any], timeout: int | None = None) -> Any:  # noqa: ASYNC109
        self.calls.append(method)
        name = type(method).__name__
        chat_id = getattr(method, "chat_id", None)
        if self.down:
            status, body = 500, {"ok": False, "error_code": 500, "description": "Internal Server Error"}
        elif name == "SendMessage" and chat_id in self.blocked_chats:
            forbidden = "Forbidden: bot was blocked by the user"
            status, body = 403, {"ok": False, "error_code": 403, "description": forbidden}
        elif name in ("SendMessage", "EditMessageText"):
            if name == "SendMessage":
                self._next_id += 1
            message_id = getattr(method, "message_id", None) or self._next_id
            result = {"message_id": message_id, "date": int(time.time()), "chat": {"id": chat_id, "type": "private"},
                      "text": method.text}
            status, body = 200, {"ok": True, "result": result}
        elif name == "GetWebhookInfo":
            status, body = 200, {"ok": True, "result": {"url": "", "has_custom_certificate": False,
                                                         "pending_update_count": 0}}
        else:
            status, body = 200, {"ok": True, "result": True}
        return self.check_response(bot, method, status, json.dumps(body)).result

    def named(self, name: str) -> list[Any]:
        return [m for m in self.calls if type(m).__name__ == name]


@pytest.fixture
def tg() -> FakeSession:
    return FakeSession()


@pytest.fixture
async def client(settings: Settings, tg: FakeSession, store: Store) -> AsyncIterator[httpx.AsyncClient]:
    def make_bot(_: Settings) -> Bot:
        return Bot(BOT_TOKEN, session=tg, default=DefaultBotProperties(parse_mode=ParseMode.HTML,
                                                                      link_preview_is_disabled=True))

    app = create_app(settings, make_bot=make_bot)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://notify.test") as c:
        yield c


@pytest.fixture
def auth() -> dict[str, str]:
    return {"X-Api-Key": API_KEY}


_update_id = 1000


def message_update(chat_id: int, text: str, *, lang: str = "en", first_name: str = "Alex") -> dict[str, Any]:
    global _update_id
    _update_id += 1
    entities = [{"type": "bot_command", "offset": 0, "length": len(text.split()[0])}] if text.startswith("/") else None
    message: dict[str, Any] = {
        "message_id": _update_id,
        "date": int(time.time()),
        "chat": {"id": chat_id, "type": "private"},
        "from": {"id": chat_id, "is_bot": False, "first_name": first_name, "language_code": lang},
        "text": text,
    }
    if entities:
        message["entities"] = entities
    return {"update_id": _update_id, "message": message}


def callback_update(chat_id: int, data: str, message_id: int, *, lang: str = "en") -> dict[str, Any]:
    global _update_id
    _update_id += 1
    return {
        "update_id": _update_id,
        "callback_query": {
            "id": f"cb{_update_id}",
            "chat_instance": "ci",
            "from": {"id": chat_id, "is_bot": False, "first_name": "Alex", "language_code": lang},
            "data": data,
            "message": {
                "message_id": message_id,
                "date": int(time.time()),
                "chat": {"id": chat_id, "type": "private"},
                "text": "invite",
            },
        },
    }


async def send_update(client: httpx.AsyncClient, update: dict[str, Any]) -> httpx.Response:
    return await client.post("/telegram/webhook", json=update, headers={"X-Telegram-Bot-Api-Secret-Token": SECRET})
