# src/kolo/core/config.py

"""All application settings in one place. Values are taken from KOLO_* environment variables."""
from functools import lru_cache
from typing import Literal

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="KOLO_", extra="ignore")

    env: Literal["dev", "test", "prod"] = "dev"
    public_url: str = "http://localhost:3000"  # frontend address, for invitation links

    # Storages. "memory://" = everything in process memory (useful for early stages and tests)
    database_url: str = "memory://"
    redis_url: str | None = None

    # Security
    jwt_secret: SecretStr = SecretStr("dev-only-secret-change-me-in-production-0123456789")
    jwt_ttl_seconds: int = 2 * 60 * 60
    cors_origins: list[str] = ["http://localhost:3000"]
    api_keys: list[SecretStr] = []
    require_api_key: bool = False

    # Rooms
    default_max_participants: int = 2
    max_participants_limit: int = 8
    room_ttl_hours: int = 24
    room_cache_ttl_seconds: int = 60
    presence_ttl_seconds: int = 60

    # STUN / TURN
    stun_urls: list[str] = ["stun:stun.l.google.com:19302"]
    turn_urls: list[str] = []
    turn_secret: SecretStr | None = None
    turn_ttl_seconds: int = 60 * 60

    # Rate limits
    rooms_per_minute_per_ip: int = 10
    ws_messages_per_second: float = 20.0
    ws_burst: int = 40
    ws_max_message_bytes: int = 64 * 1024

    # Webhooks for integration with other projects
    webhook_url: str | None = None
    webhook_secret: SecretStr | None = None


@lru_cache
def get_settings() -> Settings:
    return Settings()