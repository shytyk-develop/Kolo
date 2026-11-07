# tests/conftest.py

import pytest
from fastapi.testclient import TestClient

from kolo.container import build_container
from kolo.core.config import Settings
from kolo.main import create_app
from kolo.services.events import RecordingEventSink


@pytest.fixture
def settings() -> Settings:
    # don't read the local .env
    return Settings(
        _env_file=None,
        env="test",
        database_url="memory://",
        redis_url=None,
        jwt_secret="test-secret-that-is-long-enough-for-hs256-0123456789",
        turn_urls=["turn:turn.example.com:3478"],
        turn_secret="turn-test-secret",
        rooms_per_minute_per_ip=1000,
    )


@pytest.fixture
def events() -> RecordingEventSink:
    return RecordingEventSink()


@pytest.fixture
def client(settings, events):
    async def factory(s):
        return await build_container(s, events=events)

    # "with" runs lifespan, one loop for all sockets
    with TestClient(create_app(settings, container_factory=factory)) as test_client:
        yield test_client


def create_room(client: TestClient, **body) -> dict:
    response = client.post("/api/v1/rooms", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def join(client: TestClient, code: str, name: str, host_secret: str | None = None) -> dict:
    body = {"display_name": name}
    if host_secret:
        body["host_secret"] = host_secret
    response = client.post(f"/api/v1/rooms/{code}/join", json=body)
    assert response.status_code == 200, response.text
    return response.json()
