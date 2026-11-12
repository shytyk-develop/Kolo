import pytest

from notify.config import ConfigError, Settings
from notify.store import asyncpg_dsn

GOOD = {
    "BOT_TOKEN": "42:abc",
    "BOT_USERNAME": "@kolo_bot",
    "WEBHOOK_SECRET": "a" * 32,
    "NOTIFY_API_KEY": "k" * 32,
    "DATABASE_URL": "postgresql://u:p@host/db",
    "NOTIFY_PUBLIC_URL": "https://notify.example/",
}


def test_settings_from_env():
    s = Settings.from_env(GOOD)
    assert s.bot_username == "kolo_bot"
    assert s.public_url == "https://notify.example"
    assert s.kolo_url == "https://kolo-black.vercel.app"
    assert Settings.from_env({**GOOD, "KOLO_PUBLIC_URL": "https://kolo.example/"}).kolo_url == "https://kolo.example"


def test_settings_say_everything_that_is_wrong():
    with pytest.raises(ConfigError) as err:
        Settings.from_env({**GOOD, "BOT_TOKEN": " ", "WEBHOOK_SECRET": "short!", "NOTIFY_API_KEY": "tiny"})
    assert err.value.problems == [
        "BOT_TOKEN is not set",
        "WEBHOOK_SECRET must be 16-256 chars of A-Z a-z 0-9 _ -",
        "NOTIFY_API_KEY must be at least 24 chars",
    ]


def test_neon_url_is_made_asyncpg_friendly():
    url = "postgres://u:p@ep-x-pooler.neon.tech/neondb?sslmode=require&channel_binding=require"
    assert asyncpg_dsn(url) == "postgresql://u:p@ep-x-pooler.neon.tech/neondb?sslmode=require"
