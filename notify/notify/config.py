from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

DEFAULT_KOLO_URL = "https://kolo-black.vercel.app"
REQUIRED = ("BOT_TOKEN", "BOT_USERNAME", "WEBHOOK_SECRET", "NOTIFY_API_KEY", "DATABASE_URL", "NOTIFY_PUBLIC_URL")
# what Telegram accepts as a webhook secret_token
SECRET_RE = re.compile(r"^[A-Za-z0-9_-]{16,256}$")


class ConfigError(RuntimeError):
    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = problems


@dataclass(frozen=True, slots=True)
class Settings:
    bot_token: str
    bot_username: str
    webhook_secret: str
    api_key: str
    database_url: str
    public_url: str
    kolo_url: str

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        env = os.environ if env is None else env
        get = lambda key: env.get(key, "").strip()  # noqa: E731
        problems = [f"{key} is not set" for key in REQUIRED if not get(key)]
        if get("WEBHOOK_SECRET") and not SECRET_RE.fullmatch(get("WEBHOOK_SECRET")):
            problems.append("WEBHOOK_SECRET must be 16-256 chars of A-Z a-z 0-9 _ -")
        if get("NOTIFY_API_KEY") and len(get("NOTIFY_API_KEY")) < 24:
            problems.append("NOTIFY_API_KEY must be at least 24 chars")
        for key in ("NOTIFY_PUBLIC_URL", "KOLO_PUBLIC_URL"):
            if get(key) and not get(key).startswith(("https://", "http://")):
                problems.append(f"{key} must start with https://")
        if problems:
            raise ConfigError(problems)
        return cls(
            bot_token=get("BOT_TOKEN"),
            bot_username=get("BOT_USERNAME").removeprefix("@"),
            webhook_secret=get("WEBHOOK_SECRET"),
            api_key=get("NOTIFY_API_KEY"),
            database_url=get("DATABASE_URL"),
            public_url=get("NOTIFY_PUBLIC_URL").rstrip("/"),
            kolo_url=(get("KOLO_PUBLIC_URL") or DEFAULT_KOLO_URL).rstrip("/"),
        )


def load_dotenv(path: str | Path = ".env") -> None:
    # for the CLI scripts; never overrides the real env
    file = Path(path)
    if not file.is_file():
        return
    for line in file.read_text().splitlines():
        key, sep, value = line.strip().partition("=")
        if sep and key and not key.startswith("#"):
            os.environ.setdefault(key.strip(), value.strip().strip("'\""))
