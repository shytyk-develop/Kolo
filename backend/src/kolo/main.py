# src/kolo/main.py
from fastapi import FastAPI
from kolo.api.routes import health
from kolo.core.config import Settings, get_settings
from kolo.core.logging import configure_logging

def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings)
    
    app = FastAPI(title="Kolo API", version="0.1.0")
    app.state.settings = settings
    app.include_router(health.router)
    
    return app