"""Sealed signaling, lookup limits, fresh ice, headers, errors that say nothing."""
import asyncio
import time
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from fastapi import WebSocketDisconnect
from fastapi.testclient import TestClient
from pydantic import SecretStr

from kolo.container import build_container
from kolo.core.config import Settings
from kolo.core.security import JWT_ALGORITHM
from kolo.domain.models import Room
from kolo.main import create_app
from kolo.repositories.memory import InMemoryRoomRepository
from tests.conftest import create_room, join

BOX = "A" * 64
KID = "abcDEF123_-x"


def ws_url(ticket: dict) -> str:
    return f"{ticket['ws_path']}?token={ticket['token']}"


def expired_token(settings, code: str) -> str:
    now = int(time.time())
    claims = {"sub": "p_x", "room": code, "name": "Old", "role": "guest", "iat": now - 100, "exp": now - 10}
    return jwt.encode(claims, settings.jwt_secret.get_secret_value(), algorithm=JWT_ALGORITHM)


def join_with_kid(client: TestClient, code: str, name: str, kid: str) -> dict:
    response = client.post(f"/api/v1/rooms/{code}/join", json={"display_name": name, "kid": kid})
    assert response.status_code == 200, response.text
    return response.json()


# ---------- sealed signaling ----------


def test_sealed_message_is_relayed_untouched_to_one_peer(client):
    room = create_room(client, max_participants=3)
    anya = join(client, room["code"], "Anya")
    borya = join(client, room["code"], "Borya")
    vera = join(client, room["code"], "Vera")

    with (
        client.websocket_connect(ws_url(anya)) as ws_a,
        client.websocket_connect(ws_url(borya)) as ws_b,
        client.websocket_connect(ws_url(vera)) as ws_v,
    ):
        ws_v.receive_json()  # welcome
        ws_b.send_json({"type": "sealed", "to": anya["participant_id"], "box": BOX})
        # ping -> pong proves nothing else was queued for Vera
        ws_v.send_json({"type": "ping"})
        assert ws_v.receive_json()["type"] == "pong"

        seen = []
        while not seen or seen[-1]["type"] != "sealed":
            seen.append(ws_a.receive_json())
        assert seen[-1] == {"type": "sealed", "from": borya["participant_id"], "box": BOX}


def test_sealed_broadcast_goes_to_everyone_but_the_sender(client):
    room = create_room(client)
    anya = join(client, room["code"], "Anya")
    borya = join(client, room["code"], "Borya")

    with client.websocket_connect(ws_url(anya)) as ws_a, client.websocket_connect(ws_url(borya)) as ws_b:
        ws_b.receive_json()
        ws_b.send_json({"type": "sealed", "box": BOX})
        ws_b.send_json({"type": "ping"})
        assert ws_b.receive_json()["type"] == "pong"  # no echo of my own box

        got = ws_a.receive_json()
        while got["type"] != "sealed":
            got = ws_a.receive_json()
        assert got["from"] == borya["participant_id"]


@pytest.mark.parametrize("box", ["", "short", "has spaces " * 4, "<b>not-base64</b>" * 2, "A" * 48_001])
def test_bad_sealed_box_is_refused(client, box):
    room = create_room(client)
    anya = join(client, room["code"], "Anya")

    with client.websocket_connect(ws_url(anya)) as ws:
        ws.receive_json()
        ws.send_json({"type": "sealed", "box": box})
        assert ws.receive_json()["type"] == "error"


def test_key_fingerprint_reaches_the_other_side(client):
    room = create_room(client)
    anya = join_with_kid(client, room["code"], "Anya", KID)
    borya = join(client, room["code"], "Borya")

    with client.websocket_connect(ws_url(anya)) as ws_a:
        assert ws_a.receive_json()["you"]["kid"] == KID
        with client.websocket_connect(ws_url(borya)) as ws_b:
            welcome = ws_b.receive_json()
            assert welcome["peers"][0]["kid"] == KID
            assert "kid" not in welcome["you"]


@pytest.mark.parametrize("kid", ["short", "x" * 33, "with space1", "k\u00e9y-k\u00e9y-k\u00e9y"])
def test_bad_key_fingerprint_is_422(client, kid):
    room = create_room(client)
    response = client.post(f"/api/v1/rooms/{room['code']}/join", json={"display_name": "Anya", "kid": kid})
    assert response.status_code == 422


# ---------- guessing rooms ----------


def test_looking_up_rooms_is_rate_limited(settings):
    settings.lookups_per_minute_per_ip = 3

    with TestClient(create_app(settings)) as client:
        statuses = [client.get("/api/v1/rooms/aaa-bbbb-ccc").status_code for _ in range(5)]
        joined = client.post("/api/v1/rooms/aaa-bbbb-ccc/join", json={"display_name": "Eve"})

    assert statuses == [404, 404, 404, 429, 429]
    assert joined.status_code == 429
    assert joined.headers["Retry-After"] == "60"


def test_proxy_secret_decides_whose_forwarded_for_counts(settings):
    settings.lookups_per_minute_per_ip = 1
    settings.trust_proxy = True
    settings.proxy_secret = SecretStr("only-our-proxy-knows")

    def look(ip: str, secret: str | None) -> int:
        headers = {"X-Forwarded-For": ip}
        if secret:
            headers["X-Kolo-Proxy"] = secret
        return client.get("/api/v1/rooms/aaa-bbbb-ccc", headers=headers).status_code

    with TestClient(create_app(settings)) as client:
        # through our proxy: one bucket per real client
        assert look("198.51.100.1", "only-our-proxy-knows") == 404
        assert look("198.51.100.2", "only-our-proxy-knows") == 404
        assert look("198.51.100.1", "only-our-proxy-knows") == 429
        # around the proxy with made-up addresses: all in one bucket
        assert look("203.0.113.1", None) == 404
        assert look("203.0.113.2", None) == 429
        assert look("203.0.113.3", "wrong") == 429


# ---------- fresh ice ----------


def test_fresh_ice_for_someone_in_the_room(client, settings):
    room = create_room(client)
    ticket = join(client, room["code"], "Anya")

    response = client.post(
        f"/api/v1/rooms/{room['code']}/ice", headers={"Authorization": f"Bearer {ticket['token']}"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["expires_in"] == settings.turn_ttl_seconds
    turn = next(s for s in body["ice_servers"] if s.get("username"))
    expires_at, _, who = turn["username"].partition(":")
    assert who == ticket["participant_id"]
    assert 0 < int(expires_at) - time.time() <= settings.turn_ttl_seconds


def test_fresh_ice_needs_a_valid_ticket_for_this_room(client, settings):
    room = create_room(client)
    other = create_room(client)
    ticket = join(client, room["code"], "Anya")
    stranger = join(client, other["code"], "Eve")
    expired = expired_token(settings, room["code"])
    url = f"/api/v1/rooms/{room['code']}/ice"

    assert client.post(url).status_code == 401
    assert client.post(url, headers={"Authorization": "Bearer nonsense"}).status_code == 401
    assert client.post(url, headers={"Authorization": f"Basic {ticket['token']}"}).status_code == 401
    assert client.post(url, headers={"Authorization": f"Bearer {expired}"}).status_code == 401
    assert client.post(url, headers={"Authorization": f"Bearer {stranger['token']}"}).status_code == 401


def test_turn_logins_live_for_minutes():
    assert Settings(_env_file=None).turn_ttl_seconds <= 15 * 60


def test_expired_ticket_cannot_open_the_socket(client, settings):
    room = create_room(client)
    expired = expired_token(settings, room["code"])
    with client.websocket_connect(f"/ws/rooms/{room['code']}?token={expired}") as ws:
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    assert closed.value.code == 4401


# ---------- headers, cors, errors ----------


def test_api_answers_carry_security_headers(client):
    response = client.get("/api/v1/rooms/aaa-bbbb-ccc")

    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert response.headers["Cache-Control"] == "no-store"
    assert "default-src 'none'" in response.headers["Content-Security-Policy"]


def test_hsts_only_over_https(client):
    assert "Strict-Transport-Security" not in client.get("/health").headers
    secure = client.get("/health", headers={"X-Forwarded-Proto": "https"})
    assert secure.headers["Strict-Transport-Security"].startswith("max-age=")


def test_cors_lets_only_our_origins_in(client, settings):
    ours = settings.cors_origins[0]
    allowed = client.get("/api/v1/me", headers={"Origin": ours})
    foreign = client.get("/api/v1/me", headers={"Origin": "https://evil.example"})
    preflight = client.options(
        "/api/v1/rooms",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"},
    )

    assert allowed.headers["Access-Control-Allow-Origin"] == ours
    assert "Access-Control-Allow-Origin" not in foreign.headers
    assert preflight.status_code == 400
    assert "Access-Control-Allow-Origin" not in preflight.headers


def test_validation_error_does_not_echo_what_was_sent(client):
    room = create_room(client)
    secret = "s3cret-" + "x" * 200

    response = client.post(
        f"/api/v1/rooms/{room['code']}/join", json={"display_name": "Anya", "host_secret": secret}
    )

    assert response.status_code == 422
    assert secret not in response.text
    assert response.json()["error"]["code"] == "invalid_input"


def test_a_bug_answers_500_without_details(settings):
    async def broken(_settings):
        container = await build_container(_settings)

        async def explode(*_args, **_kwargs):
            raise RuntimeError("db password is hunter2")

        container.rooms.get_room = explode
        return container

    app = create_app(settings, container_factory=broken)
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/api/v1/rooms/aaa-bbbb-ccc")

    assert response.status_code == 500
    assert "hunter2" not in response.text and "Traceback" not in response.text
    assert response.json()["error"]["code"] == "internal_error"


def test_no_api_docs_in_prod():
    prod = Settings(
        _env_file=None,
        env="prod",
        jwt_secret="a-real-long-secret-for-prod-0123456789-abcdefgh",
        turn_secret="another-real-secret-0123456789",
    )
    with TestClient(create_app(prod)) as client:
        assert client.get("/docs").status_code == 404
        assert client.get("/openapi.json").status_code == 404


def test_old_rooms_are_dropped_from_memory():
    async def run() -> tuple[int, bool, bool]:
        repo = InMemoryRoomRepository()
        now = datetime.now(UTC)
        for code, age in (("old-room-aaa", 10), ("new-room-bbb", 0)):
            await repo.add(
                Room(
                    code=code,
                    name=code,
                    host_secret_hash="x",
                    max_participants=2,
                    lobby_enabled=False,
                    created_at=now - timedelta(days=age + 1),
                    expires_at=now - timedelta(days=age),
                )
            )
        deleted = await repo.delete_expired(now - timedelta(days=7))
        old, new = await repo.get_by_code("old-room-aaa"), await repo.get_by_code("new-room-bbb")
        return deleted, old is None, new is None

    assert asyncio.run(run()) == (1, True, False)
