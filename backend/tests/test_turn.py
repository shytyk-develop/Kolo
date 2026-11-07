# tests/test_turn.py

import base64
import hashlib
import hmac

from fastapi.testclient import TestClient
from pydantic import SecretStr

from kolo.core.config import Settings
from kolo.main import create_app
from kolo.services.turn import ice_servers_for, turn_credentials

STUN = ["stun:stun.example.com:3478"]
TURN = ["turn:turn.example.com:3478?transport=udp"]


def test_turn_credentials_match_coturn_formula() -> None:
    username, credential = turn_credentials("north", "p_42", ttl_seconds=3600, now=1_700_000_000)

    assert username == "1700003600:p_42"
    expected = base64.b64encode(hmac.new(b"north", username.encode(), hashlib.sha1).digest())
    assert credential == expected.decode()


def test_turn_credentials_match_known_value() -> None:
    # fixed value, also catches a changed algorithm
    _, credential = turn_credentials("north", "p_42", ttl_seconds=3600, now=1_700_000_000)

    assert credential == "sOCMPz+d9GXKCRpPXUEtBvRJv1w="


def test_ice_servers_without_turn_have_no_credentials(settings: Settings) -> None:
    settings.stun_urls, settings.turn_urls = STUN, TURN
    settings.turn_secret = None  # urls only, no secret to sign with

    assert ice_servers_for(settings, "p_42") == [{"urls": STUN}]


def test_join_returns_a_personal_turn_login(settings: Settings) -> None:
    settings.stun_urls, settings.turn_urls = STUN, TURN
    settings.turn_secret = SecretStr("north")

    with TestClient(create_app(settings)) as client:
        code = client.post("/api/v1/rooms", json={}).json()["code"]
        tickets = [
            client.post(f"/api/v1/rooms/{code}/join", json={"display_name": name}).json()
            for name in ("Anya", "Borya")
        ]

    logins = set()
    for ticket in tickets:
        stun, turn = ticket["ice_servers"]
        assert stun == {"urls": STUN}
        assert turn["urls"] == TURN

        # same check coturn does
        expires_at, _, peer = turn["username"].partition(":")
        assert peer == ticket["participant_id"]
        assert expires_at.isdigit()
        signature = hmac.new(b"north", turn["username"].encode(), hashlib.sha1).digest()
        assert turn["credential"] == base64.b64encode(signature).decode()
        logins.add(turn["username"])

    assert len(logins) == 2


def test_join_without_turn_returns_only_stun(settings: Settings) -> None:
    settings.stun_urls, settings.turn_urls, settings.turn_secret = STUN, [], None

    with TestClient(create_app(settings)) as client:
        code = client.post("/api/v1/rooms", json={}).json()["code"]
        ticket = client.post(f"/api/v1/rooms/{code}/join", json={"display_name": "Anya"}).json()

    # no "username": null, the browser reads it as "null"
    assert ticket["ice_servers"] == [{"urls": STUN}]
