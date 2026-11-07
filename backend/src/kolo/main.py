# src/kolo/main.py

import asyncio
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from kolo.api.errors import dependency_error_handler, kolo_error_handler
from kolo.api.routes import health, rooms
from kolo.api.ws import signaling
from kolo.container import build_container
from kolo.core.config import Settings, get_settings
from kolo.core.logging import configure_logging
from kolo.domain.errors import KoloError
from kolo.infra.errors import DEPENDENCY_ERROR_TYPES


async def room_cleaner(container):
    """Deletes rooms that expired over a week ago."""
    while True:
        try:
            older_than = datetime.now(UTC) - timedelta(days=7)
            # memory repo has no delete_expired
            if hasattr(container.rooms._repo, 'delete_expired'):
                deleted = await container.rooms._repo.delete_expired(older_than)
                if deleted > 0:
                    print(f"Cleaned up {deleted} old rooms")
        except Exception as e:
            print(f"Room cleanup failed: {e}")
        
        # once an hour
        await asyncio.sleep(3600)

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
            await container.aclose()

    app = FastAPI(title="Kolo API", version="0.1.0", lifespan=lifespan)
    
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "Authorization", "X-API-Key"],
    )

    app.add_exception_handler(KoloError, kolo_error_handler)
    for error_type in DEPENDENCY_ERROR_TYPES:
        app.add_exception_handler(error_type, dependency_error_handler)
    
    app.include_router(health.router)
    app.include_router(rooms.router, prefix="/api/v1/rooms")
    app.include_router(signaling.router)
    
    return app