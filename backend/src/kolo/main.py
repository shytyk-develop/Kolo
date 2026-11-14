# src/kolo/main.py

import asyncio
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime, timedelta

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from kolo.api.errors import dependency_error_handler, kolo_error_handler
from kolo.api.routes import health, me, rooms
from kolo.api.ws import signaling
from kolo.container import Container, build_container
from kolo.core.config import Settings, get_settings
from kolo.core.logging import configure_logging, log
from kolo.domain.errors import KoloError
from kolo.infra.errors import DEPENDENCY_ERROR_TYPES

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-site",
    # the api serves json only, none of it may load anything
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
}


class SecurityHeaders:
    """Adds the headers above to every http answer. Plain ASGI: costs next to nothing per request."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        forwarded = Headers(scope=scope).get("x-forwarded-proto", "")
        https = scope.get("scheme") == "https" or forwarded.split(",")[0].strip() == "https"
        api = scope["path"].startswith("/api/")

        async def with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                for name, value in SECURITY_HEADERS.items():
                    headers.setdefault(name, value)
                if api:
                    headers.setdefault("Cache-Control", "no-store")
                if https:
                    headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
            await send(message)

        await self.app(scope, receive, with_headers)


async def room_cleaner(container: Container) -> None:
    """Deletes rooms that expired over a week ago."""
    while True:
        try:
            older_than = datetime.now(UTC) - timedelta(days=7)
            deleted = await container.repo.delete_expired(older_than)
            if deleted > 0:
                log.info("rooms_cleaned", count=deleted)
            if container.telegram is not None:
                await container.telegram.end_expired_invites()
        except Exception as exc:  # noqa: BLE001
            log.warning("room_cleanup_failed", error=type(exc).__name__)

        # once an hour
        await asyncio.sleep(3600)


async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    # no "input": else e.g. a mistyped host_secret would come back
    detail = [{"loc": e["loc"], "msg": e["msg"], "type": e["type"]} for e in exc.errors()]
    message = detail[0]["msg"] if detail else "Invalid input data"
    return JSONResponse(
        status_code=422,
        content={"error": {"code": "invalid_input", "message": message}, "detail": detail},
    )


async def unexpected_error_handler(request: Request, exc: Exception) -> JSONResponse:
    # the stack trace goes to the log, outside only this
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "internal_error", "message": "Something went wrong on our side"}},
    )


def create_app(settings: Settings | None = None, *, container_factory=None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        factory = container_factory or build_container
        container = await factory(settings)
        app.state.container = container

        # start the cleanup loop
        cleaner_task = asyncio.create_task(room_cleaner(container))

        try:
            yield
        finally:
            # stop the loop, close db
            cleaner_task.cancel()
            with suppress(asyncio.CancelledError):
                await cleaner_task
            await container.aclose()

    # no /docs and no schema in prod: nobody needs to browse the api from outside
    docs = {} if settings.env != "prod" else {"docs_url": None, "redoc_url": None, "openapi_url": None}
    app = FastAPI(title="Kolo API", version="0.1.0", lifespan=lifespan, **docs)

    app.add_middleware(SecurityHeaders)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        # the kolo_tg cookie rides along
        allow_credentials=True,
        allow_headers=["Content-Type", "Authorization", "X-API-Key"],
        max_age=600,
    )

    app.add_exception_handler(KoloError, kolo_error_handler)
    app.add_exception_handler(RequestValidationError, validation_error_handler)
    for error_type in DEPENDENCY_ERROR_TYPES:
        app.add_exception_handler(error_type, dependency_error_handler)
    app.add_exception_handler(Exception, unexpected_error_handler)

    app.include_router(health.router)
    app.include_router(rooms.router, prefix="/api/v1/rooms")
    app.include_router(me.router, prefix="/api/v1/me")
    app.include_router(signaling.router)

    return app
