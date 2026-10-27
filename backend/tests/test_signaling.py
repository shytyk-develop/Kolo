"""Integration test: two clients walk through the signaling handshake over real WebSocket routes."""
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
from kolo.services.signaling.session import CLOSE_OVERLOADED


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    # "with" runs lifespan, which builds the container and keeps one event loop for all sockets
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def join(client: TestClient, code: str, name: str, host_secret: str | None = None) -> dict:
    response = client.post(
        f"/api/v1/rooms/{code}/join",
        json={"display_name": name, "host_secret": host_secret},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_two_peers_handshake_and_offer(client: TestClient) -> None:
    created = client.post("/api/v1/rooms", json={"name": "Kolo"})
    assert created.status_code == 201, created.text
    room = created.json()
    code = room["code"]

    anya = join(client, code, "Аня", room["host_secret"])
    boris = join(client, code, "Боря")
    assert anya["role"] == "host"
    assert boris["role"] == "guest"

    anya_peer = {"id": anya["participant_id"], "name": "Аня", "role": "host"}
    boris_peer = {"id": boris["participant_id"], "name": "Боря", "role": "guest"}

    with client.websocket_connect(f"{anya['ws_path']}?token={anya['token']}") as ws_anya:
        welcome = ws_anya.receive_json()
        assert welcome["type"] == "welcome"
        assert welcome["you"] == anya_peer
        assert welcome["room"]["code"] == code
        assert welcome["peers"] == []

        with client.websocket_connect(f"{boris['ws_path']}?token={boris['token']}") as ws_boris:
            welcome = ws_boris.receive_json()
            assert welcome["type"] == "welcome"
            assert welcome["you"] == boris_peer
            assert welcome["peers"] == [anya_peer]

            assert ws_anya.receive_json() == {"type": "peer-joined", "peer": boris_peer}

            ws_boris.send_json({"type": "offer", "to": anya["participant_id"], "sdp": "v=0 привет"})
            assert ws_anya.receive_json() == {
                "type": "offer",
                "from": boris["participant_id"],
                "sdp": "v=0 привет",
            }

            # Spoofing attempt: a client-supplied "from" must be replaced with the real sender
            ws_boris.send_json(
                {
                    "type": "offer",
                    "to": anya["participant_id"],
                    "from": anya["participant_id"],
                    "sdp": "v=0 подделка",
                }
            )
            assert ws_anya.receive_json() == {
                "type": "offer",
                "from": boris["participant_id"],
                "sdp": "v=0 подделка",
            }


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
