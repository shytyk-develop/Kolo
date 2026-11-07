"""Integration test: two clients walk through the signaling handshake over real WebSocket routes."""
from collections import Counter
from collections.abc import Iterator
from contextlib import asynccontextmanager

import pytest
from fastapi import WebSocketDisconnect
from fastapi.testclient import TestClient
from redis.asyncio import Redis
from redis.asyncio.retry import Retry
from redis.backoff import NoBackoff
from sqlalchemy.exc import DBAPIError

from kolo.container import build_container
from kolo.core.config import Settings
from kolo.core.security import create_room_token
from kolo.domain.models import Role
from kolo.domain.room_codes import generate_room_code
from kolo.infra.broker import MemoryBroker
from kolo.main import create_app
from kolo.services.signaling.hub import SignalingHub
from kolo.services.signaling.session import CLOSE_OVERLOADED, CLOSE_POLICY, MAX_VIOLATIONS
from tests.conftest import create_room, join


def ws_url(ticket: dict) -> str:
    return f"{ticket['ws_path']}?token={ticket['token']}"


def test_two_peers_exchange_offer_answer_ice(client, events):
    room = create_room(client)
    anya = join(client, room["code"], "Аня", room["host_secret"])
    borya = join(client, room["code"], "Боря")

    with client.websocket_connect(ws_url(anya)) as ws_a:
        welcome_a = ws_a.receive_json()
        assert welcome_a["type"] == "welcome" and welcome_a["peers"] == []
        assert welcome_a["you"] == {"id": anya["participant_id"], "name": "Аня", "role": "host"}

        with client.websocket_connect(ws_url(borya)) as ws_b:
            welcome_b = ws_b.receive_json()
            assert [p["name"] for p in welcome_b["peers"]] == ["Аня"]

            joined = ws_a.receive_json()
            assert joined == {
                "type": "peer-joined",
                "peer": {"id": borya["participant_id"], "name": "Боря", "role": "guest"},
            }

            # The newcomer calls those who are already in the room
            ws_b.send_json({"type": "offer", "to": anya["participant_id"], "sdp": "v=0..."})
            offer = ws_a.receive_json()
            assert offer == {"type": "offer", "from": borya["participant_id"], "sdp": "v=0..."}

            ws_a.send_json({"type": "answer", "to": borya["participant_id"], "sdp": "v=0 ans"})
            assert ws_b.receive_json()["type"] == "answer"

            ws_a.send_json(
                {
                    "type": "ice",
                    "to": borya["participant_id"],
                    "candidate": {"candidate": "candidate:1 1 udp ...", "sdpMid": "0"},
                }
            )
            ice = ws_b.receive_json()
            assert ice["from"] == anya["participant_id"] and ice["candidate"]["sdpMid"] == "0"

        left = ws_a.receive_json()
        assert left == {"type": "peer-left", "peer_id": borya["participant_id"]}

    names = [name for name, _ in events.events]
    assert names.count("participant.joined") == 2 and "participant.left" in names


def test_from_cannot_be_spoofed(client):
    room = create_room(client)
    a, b = join(client, room["code"], "A"), join(client, room["code"], "B")
    with client.websocket_connect(ws_url(a)) as ws_a, client.websocket_connect(ws_url(b)) as ws_b:
        ws_a.receive_json(), ws_b.receive_json(), ws_a.receive_json()
        ws_b.send_json({"type": "offer", "to": a["participant_id"], "sdp": "x", "from": "admin"})
        assert ws_a.receive_json()["from"] == b["participant_id"]


def test_bad_messages_get_errors_not_disconnects(client):
    room = create_room(client)
    a = join(client, room["code"], "A")
    with client.websocket_connect(ws_url(a)) as ws:
        ws.receive_json()
        ws.send_text("не json")
        assert ws.receive_json()["code"] == "bad_message"
        ws.send_json({"type": "launch-rockets"})
        assert ws.receive_json()["code"] == "bad_message"
        ws.send_json({"type": "admit", "peer_id": "p_whatever"})
        assert ws.receive_json()["code"] == "forbidden"  # a guest can't let people in


def test_invalid_token_closes_with_4401(client):
    room = create_room(client)
    with client.websocket_connect(f"/ws/rooms/{room['code']}?token=garbage") as ws:
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 4401


def test_foreign_origin_rejected(client):
    room = create_room(client)
    ticket = join(client, room["code"], "A")
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(ws_url(ticket), headers={"origin": "https://evil.example"}):
            pass


def test_room_full(client):
    room = create_room(client, max_participants=2)
    tickets = [join(client, room["code"], name) for name in ("A", "B", "C")]
    with (
        client.websocket_connect(ws_url(tickets[0])) as ws_a,
        client.websocket_connect(ws_url(tickets[1])) as ws_b,
    ):
        ws_a.receive_json(), ws_b.receive_json()
        # REST doesn't let a fourth one in either
        response = client.post(f"/api/v1/rooms/{room['code']}/join", json={"display_name": "D"})
        assert response.status_code == 409
        with client.websocket_connect(ws_url(tickets[2])) as ws_c:
            assert ws_c.receive_json()["code"] == "room_full"
            with pytest.raises(WebSocketDisconnect) as exc:
                ws_c.receive_json()
            assert exc.value.code == 4409


# ---------- message rate limit ----------


def test_websocket_rate_limit_lets_only_the_burst_through(client, settings):
    # almost no refill while the test runs, so the numbers are exact: the burst passes, the rest doesn't
    settings.ws_messages_per_second = 0.001
    ticket = join(client, create_room(client)["code"], "A")

    with client.websocket_connect(ws_url(ticket)) as ws:
        ws.receive_json()
        for _ in range(60):
            ws.send_json({"type": "ping"})
        replies = [ws.receive_json() for _ in range(60)]

    kinds = Counter(reply["type"] if reply["type"] == "pong" else reply["code"] for reply in replies)
    assert kinds == {"pong": 40, "rate_limited": 20}


def test_endless_flood_gets_disconnected(client, settings):
    settings.ws_messages_per_second = 0.001
    ticket = join(client, create_room(client)["code"], "A")

    with client.websocket_connect(ws_url(ticket)) as ws:
        ws.receive_json()
        for _ in range(settings.ws_burst + MAX_VIOLATIONS):
            ws.send_json({"type": "ping"})

        assert all(ws.receive_json()["type"] == "pong" for _ in range(settings.ws_burst))
        # the last violation closes the socket instead of answering
        assert all(ws.receive_json()["code"] == "rate_limited" for _ in range(MAX_VIOLATIONS - 1))
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
        assert closed.value.code == CLOSE_POLICY == 1008


# ---------- broker outages ----------

CONNECTION_LOST = {"_connection_lost": True}


class FlakyBroker(MemoryBroker):
    """In-memory broker that can fail the way a Redis connection does."""

    def __init__(self) -> None:
        super().__init__()
        self.fail_publish = False
        self.fail_subscribe = False

    async def publish(self, channel: str, message: dict) -> None:
        if self.fail_publish:
            raise ConnectionError("broker is down")
        await super().publish(channel, message)

    @asynccontextmanager
    async def subscribe(self, channel: str):
        if self.fail_subscribe:
            raise ConnectionError("broker is down")

        async with super().subscribe(channel) as messages:

            async def checked():
                async for message in messages:
                    if message is CONNECTION_LOST:
                        raise ConnectionError("broker connection lost")
                    yield message

            yield checked()

    async def drop_subscribers(self) -> None:
        for channel in list(self._subscribers):
            await super().publish(channel, CONNECTION_LOST)


@pytest.fixture
def flaky(settings: Settings) -> Iterator[tuple[TestClient, FlakyBroker]]:
    broker = FlakyBroker()

    async def factory(app_settings: Settings):
        container = await build_container(app_settings)
        container.broker = broker
        container.hub = SignalingHub(broker)
        return container

    with TestClient(create_app(settings, container_factory=factory)) as test_client:
        yield test_client, broker


def two_tickets(client: TestClient) -> tuple[dict, dict]:
    code = client.post("/api/v1/rooms", json={"max_participants": 2}).json()["code"]
    return join(client, code, "Аня"), join(client, code, "Боря")


def connect(client: TestClient, ticket: dict):
    return client.websocket_connect(f"{ticket['ws_path']}?token={ticket['token']}")


def assert_try_again_later(ws) -> None:
    with pytest.raises(WebSocketDisconnect) as closed:
        ws.receive_json()
    assert closed.value.code == CLOSE_OVERLOADED == 1013


def test_lost_listener_closes_sessions_and_reconnect_recovers(flaky) -> None:
    client, broker = flaky
    anya, boris = two_tickets(client)

    with connect(client, anya) as ws_anya, connect(client, boris) as ws_boris:
        assert ws_anya.receive_json()["type"] == "welcome"
        assert ws_boris.receive_json()["type"] == "welcome"
        assert ws_anya.receive_json()["type"] == "peer-joined"

        client.portal.call(broker.drop_subscribers)

        assert_try_again_later(ws_anya)
        assert_try_again_later(ws_boris)

    # The same tokens still work, and the room gets a fresh subscription
    with connect(client, anya) as ws_anya:
        assert ws_anya.receive_json()["peers"] == []

        with connect(client, boris) as ws_boris:
            assert [p["id"] for p in ws_boris.receive_json()["peers"]] == [anya["participant_id"]]
            assert ws_anya.receive_json()["type"] == "peer-joined"

            ws_boris.send_json({"type": "offer", "to": anya["participant_id"], "sdp": "v=0"})
            assert ws_anya.receive_json() == {
                "type": "offer",
                "from": boris["participant_id"],
                "sdp": "v=0",
            }


def test_failed_publish_closes_only_the_sender(flaky) -> None:
    client, broker = flaky
    anya, boris = two_tickets(client)

    with connect(client, anya) as ws_anya:
        ws_anya.receive_json()

        with connect(client, boris) as ws_boris:
            ws_boris.receive_json()
            assert ws_anya.receive_json()["type"] == "peer-joined"

            broker.fail_publish = True
            ws_boris.send_json({"type": "chat", "text": "привет"})
            assert_try_again_later(ws_boris)
            broker.fail_publish = False

        # Anya's listener survived, so she sees Boris come back
        with connect(client, boris) as ws_boris:
            assert ws_boris.receive_json()["type"] == "welcome"
            assert ws_anya.receive_json()["type"] == "peer-joined"


def test_failed_subscribe_closes_with_try_again_later(flaky) -> None:
    client, broker = flaky
    anya, _ = two_tickets(client)

    broker.fail_subscribe = True
    with connect(client, anya) as ws_anya:
        assert_try_again_later(ws_anya)
    broker.fail_subscribe = False

    with connect(client, anya) as ws_anya:
        assert ws_anya.receive_json()["type"] == "welcome"


# ---------- Redis or the database is down while a client connects ----------

# Nothing listens on this port, so real client libraries fail with their real exceptions
CLOSED_PORT = 1


@pytest.fixture(params=["redis", "database"])
def outage(request, settings: Settings) -> Iterator[TestClient]:
    if request.param == "redis":

        async def factory(app_settings: Settings):
            return await build_container(
                app_settings,
                redis_factory=lambda: Redis(
                    host="127.0.0.1",
                    port=CLOSED_PORT,
                    decode_responses=True,
                    retry=Retry(NoBackoff(), 0),  # the default backoff takes seconds per command
                ),
            )

    else:
        settings.database_url = f"postgresql+asyncpg://kolo:kolo@127.0.0.1:{CLOSED_PORT}/kolo"
        factory = build_container

    with TestClient(create_app(settings, container_factory=factory)) as test_client:
        yield test_client


def assert_service_unavailable(response) -> None:
    assert response.status_code == 503
    assert response.headers["Retry-After"] == "5"
    assert response.json() == {
        "error": {
            "code": "service_unavailable",
            "message": "Service is temporarily unavailable, please retry",
        }
    }


def test_http_returns_503_during_outage(outage: TestClient) -> None:
    code = generate_room_code()

    assert_service_unavailable(outage.post("/api/v1/rooms", json={}))
    assert_service_unavailable(outage.post(f"/api/v1/rooms/{code}/join", json={"display_name": "Аня"}))


def test_websocket_closes_with_1013_during_outage(outage: TestClient, settings: Settings) -> None:
    code = generate_room_code()
    # /join is down as well, so issue the token the client already got before the outage
    token = create_room_token(settings, room=code, participant_id="p_1", name="Аня", role=Role.GUEST)

    with outage.websocket_connect(f"/ws/rooms/{code}?token={token}") as ws:
        assert_try_again_later(ws)


def asyncpg_error(sqlstate: str) -> DBAPIError:
    """What SQLAlchemy raises for an asyncpg error: a generic wrapper carrying the SQLSTATE."""
    orig = Exception(f"asyncpg error {sqlstate}")
    orig.sqlstate = sqlstate
    return DBAPIError("SELECT 1", {}, orig)


@pytest.mark.parametrize(
    ("error", "expected_status"),
    [
        pytest.param(asyncpg_error("57P03"), 503, id="postgres-starting-up"),
        pytest.param(asyncpg_error("57P01"), 503, id="postgres-shutting-down"),
        pytest.param(asyncpg_error("08006"), 503, id="postgres-connection-failure"),
        pytest.param(asyncpg_error("42P01"), 500, id="bug-missing-table"),
        pytest.param(RuntimeError("a bug, not an outage"), 500, id="bug-plain-exception"),
    ],
)
def test_only_outages_become_503(settings: Settings, error: Exception, expected_status: int) -> None:
    async def factory(app_settings: Settings):
        container = await build_container(app_settings)

        async def broken_join(*args, **kwargs):
            raise error

        container.rooms.join = broken_join
        return container

    app = create_app(settings, container_factory=factory)
    with TestClient(app, raise_server_exceptions=False) as test_client:
        response = test_client.post(
            f"/api/v1/rooms/{generate_room_code()}/join", json={"display_name": "Аня"}
        )

    assert response.status_code == expected_status
