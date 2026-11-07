# tests/test_security.py

import logging
import time
from pathlib import Path

import jwt
import pytest
from pydantic import ValidationError
from uvicorn.logging import AccessFormatter

from kolo.core.config import DEFAULT_JWT_SECRET, Settings
from kolo.core.logging import configure_logging
from kolo.core.security import create_room_token, decode_room_token
from kolo.domain.errors import Unauthorized
from kolo.domain.models import Role


def test_token_roundtrip(settings):
    token = create_room_token(
        settings, room="abc-defg-hij", participant_id="p_1", name="Anya", role=Role.HOST
    )
    claims = decode_room_token(settings, token)
    assert (claims.sub, claims.room, claims.role) == ("p_1", "abc-defg-hij", Role.HOST)

def test_expired_token_rejected(settings):
    settings.jwt_ttl_seconds = -1  # token is already expired
    token = create_room_token(
        settings, room="abc-defg-hij", participant_id="p_1", name="Anya", role=Role.GUEST
    )
    with pytest.raises(Unauthorized):
        decode_room_token(settings, token)

def test_alg_none_rejected(settings):
    # fake token with alg "none"
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


# ---------- prod refuses known secrets ----------

REAL = {"jwt_secret": "a-real-jwt-secret-from-the-vault", "turn_secret": "a-real-turn-secret-from-the-vault"}
SFU_URL = "wss://sfu.example.com"
ENV_EXAMPLE = Path(__file__).parents[1] / ".env.example"


def prod_settings(**overrides) -> Settings:
    return Settings(**{"_env_file": None, "env": "prod", **REAL, **overrides})


def test_prod_starts_with_real_secrets():
    settings = prod_settings()
    assert settings.env == "prod"
    assert settings.livekit_url is None  # no sfu -> livekit secret not needed


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
    # this goes to deploy logs, pydantic prints input by default
    monkeypatch.setenv("KOLO_DATABASE_URL", "postgresql+asyncpg://kolo:REAL-DB-PASSWORD@db/kolo")
    monkeypatch.setenv("KOLO_TURN_SECRET", "REAL-TURN-SECRET")

    with pytest.raises(ValidationError) as refused:
        Settings(_env_file=None, env="prod")

    message = str(refused.value)
    assert "KOLO_JWT_SECRET" in message
    # pydantic cuts long input, so just check that no input is printed
    assert "input_value" not in message
    assert "REAL-DB-PASSWORD" not in message
    assert "REAL-TURN-SECRET" not in message


@pytest.mark.parametrize("env", ["dev", "test"])
def test_defaults_stay_fine_outside_prod(env):
    assert Settings(_env_file=None, env=env, livekit_url="ws://localhost:7880").env == env


def test_unknown_env_name_is_refused():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, env="production")


# ---------- no tokens in server logs ----------

JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwXzEifQ.c2lnbmF0dXJl"


@pytest.mark.parametrize("logger_name", ["uvicorn.error", "uvicorn.access"])
def test_server_logs_hide_the_token(settings, caplog, logger_name):
    configure_logging(settings)

    with caplog.at_level(logging.INFO, logger=logger_name):
        # same call uvicorn makes for every ws
        logging.getLogger(logger_name).info(
            '%s - "WebSocket %s" [accepted]', "10.0.0.1:5000", f"/ws/rooms/abc-defg-hij?token={JWT}"
        )

    assert JWT not in caplog.text
    assert "/ws/rooms/abc-defg-hij?token=***" in caplog.text


def test_access_log_format_survives_redaction(settings, caplog):
    configure_logging(settings)

    with caplog.at_level(logging.INFO, logger="uvicorn.access"):
        logging.getLogger("uvicorn.access").info(
            '%s - "%s %s HTTP/%s" %d', "10.0.0.1:5000", "GET", f"/x?a=1&token={JWT}&b=2", "1.1", 200
        )

    # uvicorn's formatter reads args by position, must stay a 5-tuple
    record = caplog.records[-1]
    formatted = AccessFormatter(fmt="%(request_line)s %(status_code)s", use_colors=False).format(record)
    assert formatted == "GET /x?a=1&token=***&b=2 HTTP/1.1 200 OK"
