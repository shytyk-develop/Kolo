# tests/test_sfu.py

"""Small rooms are p2p, big ones get a LiveKit token."""
from collections.abc import Iterator

import jwt
import pytest
from fastapi import WebSocketDisconnect
from fastapi.testclient import TestClient
from pydantic import SecretStr

from kolo.core.config import Settings
from kolo.main import create_app
from kolo.schemas.rooms import CreateRoomRequest
from kolo.services.signaling.session import CLOSE_FORBIDDEN

LIVEKIT_URL = "wss://sfu.example.com"
API_KEY = "test-key"
API_SECRET = "test-secret-long-enough-for-hs256-signatures"


@pytest.fixture
def sfu_settings(settings: Settings) -> Settings:
    settings.livekit_url = LIVEKIT_URL
    settings.livekit_api_key = API_KEY
    settings.livekit_api_secret = SecretStr(API_SECRET)
    return settings


@pytest.fixture
def client(sfu_settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(sfu_settings)) as test_client:
        yield test_client


def create_room(client: TestClient, **body) -> dict:
    response = client.post("/api/v1/rooms", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def join(client: TestClient, room: dict, name: str, *, host: bool = False) -> dict:
    body = {"display_name": name, "host_secret": room["host_secret"] if host else None}
    response = client.post(f"/api/v1/rooms/{room['code']}/join", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def connect(client: TestClient, ticket: dict):
    return client.websocket_connect(f"{ticket['ws_path']}?token={ticket['token']}")


def claims(token: str) -> dict:
    # check the signature too, livekit would reject a bad one
    return jwt.decode(token, API_SECRET, algorithms=["HS256"], options={"verify_aud": False})


# ---------- p2p or sfu ----------


@pytest.mark.parametrize(("max_participants", "mode"), [(4, "p2p"), (5, "sfu"), (50, "sfu")])
def test_room_size_picks_the_media_mode(client: TestClient, max_participants: int, mode: str) -> None:
    room = create_room(client, max_participants=max_participants)

    ticket = join(client, room, "Anya")

    assert ticket["media_mode"] == mode
    assert ("sfu_token" in ticket) == (mode == "sfu")
    assert ticket.get("sfu_url") == (LIVEKIT_URL if mode == "sfu" else None)


def test_big_room_stays_p2p_without_livekit(settings: Settings) -> None:
    assert settings.livekit_url is None

    with TestClient(create_app(settings)) as client:
        ticket = join(client, create_room(client, max_participants=8), "Anya")

    assert ticket["media_mode"] == "p2p"
    assert "sfu_url" not in ticket
    assert "sfu_token" not in ticket


def test_room_size_is_capped_at_50(client: TestClient) -> None:
    assert client.post("/api/v1/rooms", json={"max_participants": 51}).status_code == 422
    assert client.post("/api/v1/rooms", json={"max_participants": 50}).status_code == 201


def test_uses_sfu_threshold_comes_from_settings(sfu_settings: Settings, client: TestClient) -> None:
    room = create_room(client, max_participants=8)
    ticket = join(client, room, "Anya")
    assert ticket["media_mode"] == "sfu"

    sfu_settings.p2p_max_participants = 8
    assert join(client, room, "Borya")["media_mode"] == "p2p"


# ---------- token contents ----------


def test_guest_token_grants_only_this_room(client: TestClient) -> None:
    room = create_room(client, max_participants=5)
    ticket = join(client, room, "Borya")

    token = claims(ticket["sfu_token"])

    assert token["iss"] == API_KEY
    assert token["sub"] == ticket["participant_id"]
    assert token["name"] == "Borya"
    assert token["video"]["roomJoin"] is True
    assert token["video"]["room"] == room["code"]
    assert token["video"]["canPublish"] is True
    assert token["video"]["canSubscribe"] is True
    assert not token["video"].get("roomAdmin")


def test_only_the_host_token_is_admin(client: TestClient) -> None:
    room = create_room(client, max_participants=5)

    assert claims(join(client, room, "Anya", host=True)["sfu_token"])["video"]["roomAdmin"] is True
    assert not claims(join(client, room, "Borya")["sfu_token"])["video"].get("roomAdmin")


def test_token_lives_as_long_as_the_room_token(sfu_settings: Settings, client: TestClient) -> None:
    room = create_room(client, max_participants=5)
    ticket = join(client, room, "Anya")

    sfu = claims(ticket["sfu_token"])
    signaling = jwt.decode(ticket["token"], options={"verify_signature": False})

    assert sfu["exp"] - sfu["nbf"] == sfu_settings.jwt_ttl_seconds
    assert abs(sfu["exp"] - signaling["exp"]) <= 2


def test_the_two_tokens_are_signed_with_different_secrets(sfu_settings: Settings, client: TestClient) -> None:
    ticket = join(client, create_room(client, max_participants=5), "Anya")

    with pytest.raises(jwt.InvalidSignatureError):
        jwt.decode(
            ticket["sfu_token"],
            sfu_settings.jwt_secret.get_secret_value(),
            algorithms=["HS256"],
            options={"verify_aud": False},
        )


def test_request_schema_allows_the_same_size_as_settings(settings: Settings) -> None:
    field = CreateRoomRequest.model_fields["max_participants"]
    assert any(getattr(rule, "le", None) == settings.max_participants_limit for rule in field.metadata)


def test_every_token_caps_the_livekit_room(client: TestClient) -> None:
    room = create_room(client, max_participants=7, lobby_enabled=True)
    host = join(client, room, "Anya", host=True)
    guest = join(client, room, "Borya")

    with connect(client, host) as ws_host, connect(client, guest) as ws_guest:
        ws_host.receive_json()
        ws_guest.receive_json()
        ws_host.receive_json()
        ws_host.send_json({"type": "admit", "peer_id": guest["participant_id"]})
        welcome = ws_guest.receive_json()

    # people can skip our ws, so livekit has to enforce it
    assert claims(host["sfu_token"])["roomConfig"]["maxParticipants"] == 7
    assert claims(welcome["sfu_token"])["roomConfig"]["maxParticipants"] == 7


# ---------- lobby must hold for livekit too ----------


def test_lobby_guest_gets_no_token_before_admission(client: TestClient) -> None:
    room = create_room(client, max_participants=5, lobby_enabled=True)

    ticket = join(client, room, "Borya")

    assert ticket["media_mode"] == "sfu"
    assert ticket["sfu_url"] == LIVEKIT_URL  # not secret, client needs it early
    assert "sfu_token" not in ticket


def test_lobby_host_gets_the_token_right_away(client: TestClient) -> None:
    room = create_room(client, max_participants=5, lobby_enabled=True)

    assert "sfu_token" in join(client, room, "Anya", host=True)


def test_admitted_guest_gets_the_token_in_welcome(client: TestClient) -> None:
    room = create_room(client, max_participants=5, lobby_enabled=True)
    host = join(client, room, "Anya", host=True)
    guest = join(client, room, "Borya")

    with connect(client, host) as ws_host, connect(client, guest) as ws_guest:
        assert "sfu_token" not in ws_host.receive_json()
        assert ws_guest.receive_json() == {"type": "lobby", "status": "waiting"}
        assert ws_host.receive_json()["type"] == "lobby-request"

        ws_host.send_json({"type": "admit", "peer_id": guest["participant_id"]})

        welcome = ws_guest.receive_json()
        assert welcome["type"] == "welcome"
        token = claims(welcome["sfu_token"])
        assert token["sub"] == guest["participant_id"]
        assert token["name"] == "Borya"
        assert token["video"]["room"] == room["code"]
        assert not token["video"].get("roomAdmin")

        # token is personal, host must never get it
        for _ in range(2):
            message = ws_host.receive_json()
            assert message["type"] in {"lobby-left", "peer-joined"}
            assert "sfu_token" not in message


def test_denied_guest_never_sees_a_token(client: TestClient) -> None:
    room = create_room(client, max_participants=5, lobby_enabled=True)
    host = join(client, room, "Anya", host=True)
    guest = join(client, room, "Borya")

    with connect(client, host) as ws_host, connect(client, guest) as ws_guest:
        ws_host.receive_json()
        assert ws_guest.receive_json() == {"type": "lobby", "status": "waiting"}
        ws_host.receive_json()

        ws_host.send_json({"type": "deny", "peer_id": guest["participant_id"]})

        assert ws_guest.receive_json() == {"type": "denied"}
        with pytest.raises(WebSocketDisconnect) as closed:
            ws_guest.receive_json()
        assert closed.value.code == CLOSE_FORBIDDEN


def test_admitted_guest_gets_a_token_again_after_reconnect(client: TestClient) -> None:
    room = create_room(client, max_participants=5, lobby_enabled=True)
    host = join(client, room, "Anya", host=True)
    guest = join(client, room, "Borya")

    with connect(client, host) as ws_host:
        ws_host.receive_json()
        with connect(client, guest) as ws_guest:
            ws_guest.receive_json()
            ws_host.receive_json()
            ws_host.send_json({"type": "admit", "peer_id": guest["participant_id"]})
            assert "sfu_token" in ws_guest.receive_json()

        with connect(client, guest) as ws_guest:
            welcome = ws_guest.receive_json()
            assert welcome["type"] == "welcome"
            assert claims(welcome["sfu_token"])["sub"] == guest["participant_id"]


def test_small_lobby_room_has_no_token_in_welcome(client: TestClient) -> None:
    room = create_room(client, max_participants=4, lobby_enabled=True)
    host = join(client, room, "Anya", host=True)
    guest = join(client, room, "Borya")

    with connect(client, host) as ws_host, connect(client, guest) as ws_guest:
        ws_host.receive_json()
        ws_guest.receive_json()
        ws_host.receive_json()
        ws_host.send_json({"type": "admit", "peer_id": guest["participant_id"]})

        welcome = ws_guest.receive_json()
        assert welcome["type"] == "welcome"
        assert "sfu_token" not in welcome
