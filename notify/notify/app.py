from __future__ import annotations

import hmac
import re
import secrets
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Annotated, Any, Literal

import asyncpg
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import AfterValidator, BaseModel, BeforeValidator, Field, model_validator

from . import openpage
from .config import ConfigError, Settings
from .handles import is_handle, is_room_code, normalize_handle
from .invites import CallerUnknown, DeliveryFailed, InviteRequest, RateLimited, end_invite, send_invite
from .logs import log, log_error
from .signing import verify
from .store import LINK_TTL, Store, connect
from .texts import pick_lang

Connect = Callable[[str], Awaitable[asyncpg.Connection]]
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")


def _handle(value: str) -> str:
    if not is_handle(value):
        raise ValueError("must be 3-20 chars of a-z 0-9 _")
    return value


def _name(value: str) -> str:
    # one line, or it breaks the message layout
    clean = " ".join(value.split())
    if not clean:
        raise ValueError("must not be blank")
    return clean


def _room(value: str) -> str:
    if not is_room_code(value):
        raise ValueError("must look like abc-defg-hij")
    return value


Handle = Annotated[
    str, BeforeValidator(lambda v: normalize_handle(v) if isinstance(v, str) else v), AfterValidator(_handle)
]


class InviteIn(BaseModel):
    caller: Handle
    caller_name: Annotated[str, Field(min_length=1, max_length=40), AfterValidator(_name)]
    target: Handle
    room: Annotated[str, AfterValidator(_room)]

    @model_validator(mode="after")
    def _not_self(self) -> InviteIn:
        if self.caller == self.target:
            raise ValueError("caller and target are the same")
        return self


class InviteOut(BaseModel):
    invite_id: uuid.UUID
    status: Literal["sent", "needs_acceptance", "undeliverable"]


class PairIn(BaseModel):
    a: Handle
    b: Handle

    @model_validator(mode="after")
    def _two(self) -> PairIn:
        if self.a == self.b:
            raise ValueError("a and b are the same")
        return self


class LinkOut(BaseModel):
    token: str
    deep_link: str
    expires_in: int


class LinkStatus(BaseModel):
    status: Literal["pending", "linked", "expired"]
    handle: str | None = None
    display_name: str | None = None


def get_settings(request: Request) -> Settings:
    state = request.app.state
    if state.settings is None:
        state.settings = Settings.from_env()
    return state.settings


SettingsDep = Annotated[Settings, Depends(get_settings)]


async def get_store(request: Request, settings: SettingsDep) -> AsyncIterator[Store]:
    conn = await request.app.state.connect(settings.database_url)
    try:
        yield Store(conn)
    finally:
        await conn.close()


StoreDep = Annotated[Store, Depends(get_store)]


def require_api_key(request: Request, settings: SettingsDep) -> None:
    given = request.headers.get("X-Api-Key", "")
    if not hmac.compare_digest(given.encode(), settings.api_key.encode()):
        raise HTTPException(401, "bad or missing X-Api-Key")


def create_app(
    settings: Settings | None = None,
    *,
    make_bot: Callable[[Settings], Any] | None = None,
    connect_db: Connect = connect,
) -> FastAPI:
    app = FastAPI(title="kolo notify", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings
    app.state.connect = connect_db
    app.state.make_bot = make_bot

    def bot_factory() -> Callable[[Settings], Any]:
        if app.state.make_bot is None:
            from .telegram import make_bot as real

            app.state.make_bot = real
        return app.state.make_bot

    @app.exception_handler(ConfigError)
    async def _misconfigured(_: Request, exc: ConfigError) -> JSONResponse:
        log_error("misconfigured", problems=exc.problems)
        return JSONResponse({"detail": "service is not configured"}, status_code=503)

    @app.get("/health")
    async def health(request: Request) -> JSONResponse:
        try:
            get_settings(request)
        except ConfigError as exc:
            return JSONResponse({"status": "misconfigured", "problems": exc.problems}, status_code=503)
        return JSONResponse({"status": "ok"})

    @app.get("/open", response_class=HTMLResponse)
    async def open_link(
        settings: SettingsDep,
        u: str = "",
        s: str = "",
        lang: Annotated[str, Query(alias="l")] = "en",
    ) -> HTMLResponse:
        nonce = secrets.token_urlsafe(16)
        ok = verify(settings.api_key, u, s, settings.kolo_url)
        page = openpage.render(u if ok else None, pick_lang(lang), nonce)
        return HTMLResponse(page, status_code=200 if ok else 403, headers=openpage.headers(nonce))

    @app.post("/telegram/webhook")
    async def webhook(request: Request, settings: SettingsDep) -> JSONResponse:
        given = request.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
        if not hmac.compare_digest(given.encode(), settings.webhook_secret.encode()):
            raise HTTPException(403, "bad secret token")
        try:
            update = await request.json()
        except ValueError:
            raise HTTPException(400, "not json") from None

        from .bot import dispatcher

        conn = await app.state.connect(settings.database_url)
        try:
            async with bot_factory()(settings) as bot:
                await dispatcher().feed_webhook_update(bot, update, store=Store(conn), settings=settings)
        except Exception:
            # still 200, or Telegram resends it forever
            log_error("update_failed", update_id=update.get("update_id") if isinstance(update, dict) else None)
        finally:
            await conn.close()
        return JSONResponse({"ok": True})

    v1 = APIRouter(prefix="/v1", dependencies=[Depends(require_api_key)])

    @v1.post("/link", status_code=201)
    async def new_link(store: StoreDep, settings: SettingsDep) -> LinkOut:
        token = secrets.token_urlsafe(18)
        await store.new_link_token(token)
        deep_link = f"https://t.me/{settings.bot_username}?start=link_{token}"
        return LinkOut(token=token, deep_link=deep_link, expires_in=int(LINK_TTL.total_seconds()))

    @v1.get("/link/{token}")
    async def link_status(token: str, store: StoreDep) -> LinkStatus:
        status = await store.link_status(token) if TOKEN_RE.fullmatch(token) else None
        if status is None:
            raise HTTPException(404, "no such link token")
        return LinkStatus(**status)

    @v1.post("/invite", status_code=202, response_model=InviteOut)
    async def invite(body: InviteIn, store: StoreDep, settings: SettingsDep) -> InviteOut | JSONResponse:
        req = InviteRequest(caller=body.caller, caller_name=body.caller_name, target=body.target, room=body.room)
        try:
            invite_id, status = await send_invite(store, settings, bot_factory(), req)
        except CallerUnknown:
            raise HTTPException(422, "caller is not a Kolo ID") from None
        except RateLimited as exc:
            limit = exc.limit
            return JSONResponse(
                {"detail": "too many invites", "reason": limit.reason, "retry_after": limit.retry_after},
                status_code=429,
                headers={"Retry-After": str(limit.retry_after)},
            )
        except DeliveryFailed:
            raise HTTPException(502, "Telegram didn't take the message, try again") from None
        return InviteOut(invite_id=invite_id, status=status)  # type: ignore[arg-type]

    @v1.post("/invite/{invite_id}/ended")
    async def invite_ended(invite_id: uuid.UUID, store: StoreDep, settings: SettingsDep) -> dict[str, str]:
        if not await end_invite(store, settings, bot_factory(), invite_id):
            raise HTTPException(404, "no such invite")
        return {"invite_id": str(invite_id), "status": "ended"}

    @v1.post("/calls/completed", status_code=204)
    async def call_completed(body: PairIn, store: StoreDep) -> Response:
        await store.add_pair(body.a, body.b)
        return Response(status_code=204)

    @v1.delete("/users/{handle}", status_code=204)
    async def delete_user(handle: str, store: StoreDep) -> Response:
        handle = normalize_handle(handle)
        if not is_handle(handle):
            raise HTTPException(422, "not a Kolo ID")
        await store.delete_handle(handle)
        log("user_deleted", via="api")
        return Response(status_code=204)

    app.include_router(v1)
    return app


app = create_app()
