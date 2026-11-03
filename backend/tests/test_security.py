# tests/test_security.py

import time
from pathlib import Path

import jwt
import pytest
from pydantic import ValidationError

from kolo.core.config import DEFAULT_JWT_SECRET, Settings
from kolo.core.security import create_room_token, decode_room_token
from kolo.domain.errors import Unauthorized
from kolo.domain.models import Role


def test_token_roundtrip(settings):
    token = create_room_token(settings, room="abc-defg-hij", participant_id="p_1", name="Аня", role=Role.HOST)
    claims = decode_room_token(settings, token)
    assert (claims.sub, claims.room, claims.role) == ("p_1", "abc-defg-hij", Role.HOST)

def test_expired_token_rejected(settings):
    settings.jwt_ttl_seconds = -1  # Делаем токен сразу протухшим
    token = create_room_token(
        settings, room="abc-defg-hij", participant_id="p_1", name="Аня", role=Role.GUEST
    )
    with pytest.raises(Unauthorized):
        decode_room_token(settings, token)

def test_alg_none_rejected(settings):
    # Хакерский токен: пытаемся обмануть библиотеку, сказав, что алгоритм "none"
    forged = jwt.encode(
        {
            "sub": "p_1",
            "room": "abc-defg-hij",
            "name": "x",
            "role": "host",
            "iat": 0,
            "exp": int(time.time()) + 60,
        },
        key=None, 
        algorithm="none"
    )
    with pytest.raises(Unauthorized):
        decode_room_token(settings, forged)


# ---------- production refuses to start with secrets everyone knows ----------

REAL = {"jwt_secret": "a-real-jwt-secret-from-the-vault", "turn_secret": "a-real-turn-secret-from-the-vault"}
SFU_URL = "wss://sfu.example.com"
ENV_EXAMPLE = Path(__file__).parents[1] / ".env.example"


def prod_settings(**overrides) -> Settings:
    return Settings(**{"_env_file": None, "env": "prod", **REAL, **overrides})


def test_prod_starts_with_real_secrets():
    settings = prod_settings()
    assert settings.env == "prod"
    assert settings.livekit_url is None  # the LiveKit secret isn't used without an SFU, so it isn't required


def test_prod_starts_with_a_real_livekit_secret():
    assert prod_settings(livekit_url=SFU_URL, livekit_api_secret="a-real-livekit-secret").livekit_url


@pytest.mark.parametrize(
    ("overrides", "variable"),
    [
        pytest.param({"jwt_secret": DEFAULT_JWT_SECRET}, "KOLO_JWT_SECRET", id="jwt-default"),
        pytest.param({"jwt_secret": ""}, "KOLO_JWT_SECRET", id="jwt-empty"),
        pytest.param({"turn_secret": None}, "KOLO_TURN_SECRET", id="turn-default"),
        pytest.param({"turn_secret": ""}, "KOLO_TURN_SECRET", id="turn-empty"),
        pytest.param({"livekit_url": SFU_URL}, "KOLO_LIVEKIT_API_SECRET", id="livekit-default"),
        pytest.param(
            {"livekit_url": SFU_URL, "livekit_api_secret": ""}, "KOLO_LIVEKIT_API_SECRET", id="livekit-empty"
        ),
    ],
)
def test_prod_refuses_known_secrets(overrides, variable):
    with pytest.raises(ValidationError) as refused:
        prod_settings(**overrides)
    assert variable in str(refused.value)


def test_prod_reports_every_problem_at_once():
    with pytest.raises(ValidationError) as refused:
        Settings(_env_file=None, env="prod", livekit_url=SFU_URL)
    for variable in ("KOLO_JWT_SECRET", "KOLO_TURN_SECRET", "KOLO_LIVEKIT_API_SECRET"):
        assert variable in str(refused.value)


def test_prod_refuses_placeholders_copied_from_env_example():
    with pytest.raises(ValidationError) as refused:
        Settings(_env_file=ENV_EXAMPLE, env="prod")
    for variable in ("KOLO_JWT_SECRET", "KOLO_TURN_SECRET", "KOLO_LIVEKIT_API_SECRET"):
        assert variable in str(refused.value)


def test_refusal_does_not_print_real_values(monkeypatch):
    # this message ends up in deploy logs, and pydantic prints the raw input by default
    monkeypatch.setenv("KOLO_DATABASE_URL", "postgresql+asyncpg://kolo:REAL-DB-PASSWORD@db/kolo")
    monkeypatch.setenv("KOLO_TURN_SECRET", "REAL-TURN-SECRET")

    with pytest.raises(ValidationError) as refused:
        Settings(_env_file=None, env="prod")

    message = str(refused.value)
    assert "KOLO_JWT_SECRET" in message
    # pydantic cuts long input in the middle, so a secret may slip past the checks below by luck:
    # the part that matters is that no input is printed at all
    assert "input_value" not in message
    assert "REAL-DB-PASSWORD" not in message
    assert "REAL-TURN-SECRET" not in message


@pytest.mark.parametrize("env", ["dev", "test"])
def test_defaults_stay_fine_outside_prod(env):
    assert Settings(_env_file=None, env=env, livekit_url="ws://localhost:7880").env == env


def test_unknown_env_name_is_refused():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, env="production")
