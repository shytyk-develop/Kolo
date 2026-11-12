# src/kolo/core/config.py

"""App settings, read from KOLO_* env vars."""
from functools import lru_cache
from typing import Literal

from pydantic import AliasChoices, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_JWT_SECRET = "dev-only-secret-change-me-in-production-0123456789"
DEFAULT_LIVEKIT_SECRET = "secret"

# secrets everyone knows (defaults, .env.example, empty), never in prod
PUBLICLY_KNOWN_SECRETS = {
    DEFAULT_JWT_SECRET,
    DEFAULT_LIVEKIT_SECRET,
    "your-secret-here",
    "same-as-static-auth-secret-in-coturn",
    "",
}


def _is_known(secret: SecretStr | None) -> bool:
    return secret is None or secret.get_secret_value() in PUBLICLY_KNOWN_SECRETS


class Settings(BaseSettings):
    # don't print secrets in validation errors
    model_config = SettingsConfigDict(
        env_file=".env", env_prefix="KOLO_", extra="ignore", hide_input_in_errors=True, populate_by_name=True
    )

    env: Literal["dev", "test", "prod"] = "dev"
    public_url: str = "http://localhost:3000"  # frontend url

    # storage, memory:// = all in process memory
    database_url: str = "memory://"
    redis_url: str | None = None

    # Security
    jwt_secret: SecretStr = SecretStr(DEFAULT_JWT_SECRET)
    jwt_ttl_seconds: int = 2 * 60 * 60
    cors_origins: list[str] = ["http://localhost:3000"]
    api_keys: list[SecretStr] = []
    require_api_key: bool = False

    # Rooms
    default_max_participants: int = 2
    max_participants_limit: int = 50
    room_ttl_hours: int = 24
    room_cache_ttl_seconds: int = 60
    presence_ttl_seconds: int = 60
    # a socket that dropped (not a "bye") gets this long to come back before the others hear
    # "peer-left": a wifi blip or a frozen tab must not tear down a working video call
    leave_grace_seconds: float = 20.0

    # STUN / TURN
    stun_urls: list[str] = ["stun:stun.l.google.com:19302"]
    turn_urls: list[str] = []
    turn_secret: SecretStr | None = None
    turn_ttl_seconds: int = 60 * 60

    # sfu (livekit), no livekit_url = every room is p2p
    # devkey/secret = livekit --dev defaults
    p2p_max_participants: int = 4
    livekit_url: str | None = None
    livekit_api_key: str = "devkey"
    livekit_api_secret: SecretStr = SecretStr(DEFAULT_LIVEKIT_SECRET)

    # Rate limits
    rooms_per_minute_per_ip: int = 10
    ws_messages_per_second: float = 20.0
    ws_burst: int = 40
    ws_max_message_bytes: int = 64 * 1024

    # Webhooks for integration with other projects
    webhook_url: str | None = None
    webhook_secret: SecretStr | None = None

    require_api_key: bool = False
    rooms_per_minute_per_ip: int = 10

    frontend_url: str = "http://localhost:3000"

    # behind the frontend's /api proxy (Vercel): take the client ip from X-Forwarded-For.
    # Without it every visitor looks like one of Vercel's few ips to the per-ip limits
    trust_proxy: bool = False

    # Telegram invites through the notify service; any of these missing = Telegram is off
    notify_url: str | None = Field(None, validation_alias=AliasChoices("NOTIFY_URL", "KOLO_NOTIFY_URL"))
    notify_api_key: SecretStr | None = Field(
        None, validation_alias=AliasChoices("NOTIFY_API_KEY", "KOLO_NOTIFY_API_KEY")
    )
    # signs the kolo_tg cookie
    session_secret: SecretStr | None = Field(
        None, validation_alias=AliasChoices("SESSION_SECRET", "KOLO_SESSION_SECRET")
    )
    notify_timeout_seconds: float = 5.0

    @property
    def telegram_enabled(self) -> bool:
        return bool(
            self.notify_url
            and self.notify_api_key
            and self.notify_api_key.get_secret_value()
            and self.session_secret
            and self.session_secret.get_secret_value()
        )

    @model_validator(mode="after")
    def _check_secrets(self) -> "Settings":
        # unsigned webhooks are useless, fail right away in any env
        if self.webhook_url and (self.webhook_secret is None or not self.webhook_secret.get_secret_value()):
            raise ValueError("KOLO_WEBHOOK_SECRET is required when KOLO_WEBHOOK_URL is set")

        if self.env != "prod":
            return self

        missing = []
        if _is_known(self.jwt_secret):
            missing.append("KOLO_JWT_SECRET")
        if _is_known(self.turn_secret):
            missing.append("KOLO_TURN_SECRET")
        if self.livekit_url and _is_known(self.livekit_api_secret):
            missing.append("KOLO_LIVEKIT_API_SECRET")
        if self.webhook_url and _is_known(self.webhook_secret):
            missing.append("KOLO_WEBHOOK_SECRET")

        if self.telegram_enabled and len(self.session_secret.get_secret_value()) < 32:
            missing.append("SESSION_SECRET (32+ chars)")

        if missing:
            raise ValueError(f"Refusing to start in prod, set real values for: {', '.join(missing)}")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()