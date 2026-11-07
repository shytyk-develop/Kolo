# tests/test_rooms_api.py

"""HTTP API: creating rooms, joining them, and every way that can go wrong."""
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from kolo.core.config import Settings
from kolo.domain.room_codes import is_valid_room_code
from kolo.main import create_app
from tests.conftest import create_room, join


def error_code(response) -> str:
    return response.json()["error"]["code"]


def name_in_token(settings: Settings, ticket: dict) -> str:
    return jwt.decode(ticket["token"], settings.jwt_secret.get_secret_value(), algorithms=["HS256"])["name"]


def test_create_room_returns_what_the_creator_needs(client, settings):
    room = create_room(client)

    assert is_valid_room_code(room["code"])
    assert room["name"] == f"Room {room['code']}"
    assert room["join_url"] == f"{settings.frontend_url}/r/{room['code']}"
    assert len(room["host_secret"]) >= 40
    assert room["max_participants"] == settings.default_max_participants
    assert room["lobby_enabled"] is False

    expires_in = datetime.fromisoformat(room["expires_at"]) - datetime.now(UTC)
    assert timedelta(hours=settings.room_ttl_hours) - expires_in < timedelta(minutes=1)


def test_every_room_gets_its_own_code_and_secret(client):
    rooms = [create_room(client) for _ in range(5)]
    assert len({room["code"] for room in rooms}) == 5
    assert len({room["host_secret"] for room in rooms}) == 5


@pytest.mark.parametrize(
    "body",
    [
        pytest.param({"max_participants": 1}, id="too-small"),
        pytest.param({"max_participants": 51}, id="too-big"),
        pytest.param({"name": "x" * 81}, id="name-too-long"),
    ],
)
def test_create_room_rejects_bad_input(client, body):
    assert client.post("/api/v1/rooms", json=body).status_code == 422


def test_host_secret_decides_the_role(client):
    room = create_room(client)

    host = join(client, room["code"], "Аня", room["host_secret"])
    guest = join(client, room["code"], "Боря")
    impostor = join(client, room["code"], "Вова", "a-guessed-secret")

    assert (host["role"], guest["role"], impostor["role"]) == ("host", "guest", "guest")
    assert host["ws_path"] == f"/ws/rooms/{room['code']}"
    assert len({t["participant_id"] for t in (host, guest, impostor)}) == 3


def test_join_accepts_codes_typed_by_humans(client):
    code = create_room(client)["code"]
    typed = code.replace("-", " ").upper()  # "ABC DEFG HIJ"

    assert join(client, typed, "Аня")["ws_path"] == f"/ws/rooms/{code}"


@pytest.mark.parametrize("code", ["zzz-zzzz-zzz", "not-a-code", "x" * 30])
def test_unknown_room_is_404(client, code):
    response = client.post(f"/api/v1/rooms/{code}/join", json={"display_name": "Аня"})

    assert response.status_code == 404
    assert error_code(response) == "room_not_found"


def test_expired_room_is_410(client, settings):
    settings.room_ttl_hours = 0  # the room expires the moment it's created
    code = create_room(client)["code"]

    response = client.post(f"/api/v1/rooms/{code}/join", json={"display_name": "Аня"})

    assert response.status_code == 410
    assert error_code(response) == "room_expired"


def test_display_name_is_cleaned(client, settings):
    code = create_room(client)["code"]

    ticket = join(client, code, "  Аня \n  Петрова ")

    assert name_in_token(settings, ticket) == "Аня Петрова"


@pytest.mark.parametrize("name", ["", "   ", "Аня\x00", "x" * 41])
def test_bad_display_names_are_rejected(client, name):
    code = create_room(client)["code"]
    assert client.post(f"/api/v1/rooms/{code}/join", json={"display_name": name}).status_code == 422


def test_room_creation_is_rate_limited(settings):
    settings.rooms_per_minute_per_ip = 2

    with TestClient(create_app(settings)) as client:
        statuses = [client.post("/api/v1/rooms", json={}).status_code for _ in range(3)]
        limited = client.post("/api/v1/rooms", json={})

    assert statuses == [201, 201, 429]
    assert error_code(limited) == "rate_limited"
    assert limited.headers["Retry-After"] == "60"


def test_forged_forwarded_for_does_not_bypass_the_limit(settings):
    # a client can put anything into this header: a fresh "IP" per request used to get a fresh bucket
    settings.rooms_per_minute_per_ip = 2

    with TestClient(create_app(settings)) as client:
        statuses = [
            client.post("/api/v1/rooms", json={}, headers={"X-Forwarded-For": f"203.0.113.{i}"}).status_code
            for i in range(5)
        ]

    assert statuses == [201, 201, 429, 429, 429]


def test_behind_a_trusted_proxy_each_client_has_its_own_limit(settings):
    # in production uvicorn --proxy-headers --forwarded-allow-ips=<proxy> does this rewrite:
    # it takes the address the proxy appended, not the one the client wrote
    settings.rooms_per_minute_per_ip = 1
    # "testclient" is the peer address TestClient uses, so here it plays the proxy.
    # not "*": trusting every hop walks the chain back to the address the client forged
    app = ProxyHeadersMiddleware(create_app(settings), trusted_hosts="testclient")

    def create(chain: str) -> int:
        return client.post("/api/v1/rooms", json={}, headers={"X-Forwarded-For": chain}).status_code

    with TestClient(app) as client:
        assert create("198.51.100.1") == 201
        assert create("198.51.100.1") == 429
        assert create("198.51.100.2") == 201  # another real client is not affected
        # the forged left part is ignored: the proxy appended the real address on the right
        assert create("203.0.113.77, 198.51.100.1") == 429


def test_api_key_is_required_when_configured(settings):
    settings.require_api_key = True
    settings.api_keys = [SecretStr("partner-key")]

    with TestClient(create_app(settings)) as client:
        missing = client.post("/api/v1/rooms", json={})
        wrong = client.post("/api/v1/rooms", json={}, headers={"X-API-Key": "guess"})
        right = client.post("/api/v1/rooms", json={}, headers={"X-API-Key": "partner-key"})

    assert (missing.status_code, wrong.status_code, right.status_code) == (401, 401, 201)
    assert error_code(missing) == "unauthorized"


def test_trusted_services_skip_the_rate_limit(settings):
    settings.rooms_per_minute_per_ip = 1
    settings.api_keys = [SecretStr("partner-key")]

    with TestClient(create_app(settings)) as client:
        statuses = [
            client.post("/api/v1/rooms", json={}, headers={"X-API-Key": "partner-key"}).status_code
            for _ in range(5)
        ]

    assert statuses == [201] * 5


def test_health_endpoints(client):
    assert client.get("/health").json() == {"status": "ok"}
    ready = client.get("/health/ready")
    assert ready.status_code == 200 and ready.json()["status"] == "ok"
