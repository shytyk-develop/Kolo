"""Integration test: two clients walk through the signaling handshake over real WebSocket routes."""
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from kolo.core.config import Settings
from kolo.main import create_app


@pytest.fixture
def client() -> Iterator[TestClient]:
    # _env_file=None: the test must not depend on the developer's local .env
    settings = Settings(_env_file=None, env="test", database_url="memory://")
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
