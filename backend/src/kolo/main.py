# src/kolo/main.py

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from kolo.api.errors import kolo_error_handler
from kolo.api.routes import health, rooms
from kolo.container import build_container
from kolo.core.config import Settings, get_settings
from kolo.core.logging import configure_logging
from kolo.domain.errors import KoloError

def create_app(settings: Settings | None = None, *, container_factory=None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        factory = container_factory or build_container
        app.state.container = await factory(settings)
        try:
            yield
        finally:
            await app.state.container.aclose()

    app = FastAPI(title="Kolo API", version="0.1.0", lifespan=lifespan)
    
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "Authorization", "X-API-Key"],
    )

    app.add_exception_handler(KoloError, kolo_error_handler)
    
    app.include_router(health.router)
    app.include_router(rooms.router, prefix="/api/v1")
    
    return app