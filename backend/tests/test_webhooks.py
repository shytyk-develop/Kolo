# tests/test_webhooks.py

"""Webhooks out of Kolo and the SDK that reads them."""
import asyncio
import hashlib
import hmac
import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient
from kolo_client import KoloClient, KoloError, verify_webhook
from pydantic import SecretStr, ValidationError

from kolo.container import build_container
from kolo.core.config import Settings
from kolo.main import create_app
from kolo.services import events as events_module
from kolo.services.events import WebhookSender, sign_payload
from tests.conftest import create_room, join

SECRET = "whsec-test-secret"
URL = "https://hooks.example.com/kolo"


class Receiver:
    """Fake webhook endpoint: answers with the given statuses and keeps every request."""

    def __init__(self, *statuses: int | Exception) -> None:
        self.statuses = list(statuses) or [200]
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        answer = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
        if isinstance(answer, Exception):
            raise answer
        return httpx.Response(answer)

    def events(self) -> list[str]:
        return [json.loads(r.content)["event"] for r in self.requests]


@pytest.fixture
def hook_settings(settings: Settings) -> Settings:
    settings.webhook_url = URL
    settings.webhook_secret = SecretStr(SECRET)
    return settings


@pytest.fixture
def delays(monkeypatch) -> list[float]:
    # record the retry pauses instead of sleeping (patches asyncio.sleep for the whole test)
    slept: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        slept.append(seconds)

    monkeypatch.setattr(events_module.asyncio, "sleep", fake_sleep)
    return slept


def sender(settings: Settings, receiver: Receiver) -> WebhookSender:
    return WebhookSender(settings, client=httpx.AsyncClient(transport=httpx.MockTransport(receiver)))


async def deliver(webhooks: WebhookSender) -> None:
    await asyncio.gather(*list(webhooks._tasks))


# ---------- signature ----------


def test_signature_is_hmac_of_timestamp_dot_body():
    body = b'{"event": "room.created"}'
    expected = hmac.new(SECRET.encode(), b"1700000000." + body, hashlib.sha256).hexdigest()
    assert sign_payload(SECRET, 1700000000, body) == expected


async def test_sdk_accepts_what_kolo_sends(hook_settings):
    receiver = Receiver(200)
    webhooks = sender(hook_settings, receiver)

    webhooks.emit("participant.joined", {"room": "abc-defg-hij", "name": "Anya"})
    await deliver(webhooks)
    await webhooks.aclose()

    [request] = receiver.requests
    assert request.headers["X-Kolo-Event"] == "participant.joined"
    assert request.headers["Content-Type"] == "application/json"
    assert verify_webhook(SECRET, request.headers["X-Kolo-Signature"], request.content)
    assert not verify_webhook(SECRET + "x", request.headers["X-Kolo-Signature"], request.content)

    payload = json.loads(request.content)
    assert payload["event"] == "participant.joined"
    assert payload["data"] == {"room": "abc-defg-hij", "name": "Anya"}
    assert abs(payload["sent_at"] - time.time()) < 5


# ---------- retries ----------


async def test_server_errors_are_retried_with_backoff(hook_settings, delays):
    receiver = Receiver(500, 503, 200)
    webhooks = sender(hook_settings, receiver)

    webhooks.emit("room.created", {"code": "abc-defg-hij"})
    await deliver(webhooks)

    assert len(receiver.requests) == 3
    assert delays == [1, 2]
    # every attempt is signed again with a fresh timestamp
    for request in receiver.requests:
        assert verify_webhook(SECRET, request.headers["X-Kolo-Signature"], request.content)


async def test_gives_up_after_three_attempts_without_extra_sleep(hook_settings, delays):
    receiver = Receiver(500)
    webhooks = sender(hook_settings, receiver)

    webhooks.emit("room.created", {})
    await deliver(webhooks)

    assert len(receiver.requests) == 3
    assert delays == [1, 2]  # no pointless sleep after the last attempt


async def test_network_errors_are_retried(hook_settings, delays):
    receiver = Receiver(httpx.ConnectError("refused"), httpx.ReadTimeout("slow"), 200)
    webhooks = sender(hook_settings, receiver)

    webhooks.emit("room.created", {})
    await deliver(webhooks)

    assert len(receiver.requests) == 3


@pytest.mark.parametrize("status", [200, 204, 400, 401, 404])
async def test_answers_below_500_are_not_retried(hook_settings, delays, status):
    receiver = Receiver(status)
    webhooks = sender(hook_settings, receiver)

    webhooks.emit("room.created", {})
    await deliver(webhooks)

    assert len(receiver.requests) == 1
    assert delays == []


async def test_aclose_cancels_pending_deliveries(hook_settings):
    gate = asyncio.Event()

    async def hang(request: httpx.Request) -> httpx.Response:
        await gate.wait()
        return httpx.Response(200)

    webhooks = WebhookSender(hook_settings, client=httpx.AsyncClient(transport=httpx.MockTransport(hang)))
    webhooks.emit("room.created", {})
    await asyncio.sleep(0)
    task = next(iter(webhooks._tasks))

    await webhooks.aclose()
    await asyncio.sleep(0)
    assert task.cancelled()


# ---------- settings and wiring ----------


def test_webhook_url_without_a_secret_is_refused():
    with pytest.raises(ValidationError) as refused:
        Settings(_env_file=None, webhook_url=URL)
    assert "KOLO_WEBHOOK_SECRET" in str(refused.value)


def test_prod_refuses_an_empty_webhook_secret():
    with pytest.raises(ValidationError) as refused:
        Settings(
            _env_file=None,
            env="prod",
            jwt_secret="a-real-jwt-secret-from-the-vault",
            turn_secret="a-real-turn-secret-from-the-vault",
            webhook_url=URL,
            webhook_secret="",
        )
    assert "KOLO_WEBHOOK_SECRET" in str(refused.value)


async def test_container_sends_webhooks_only_when_configured(settings, hook_settings):
    plain = await build_container(settings.model_copy(update={"webhook_url": None, "webhook_secret": None}))
    hooked = await build_container(hook_settings)

    assert not isinstance(plain.events, WebhookSender)
    assert isinstance(hooked.events, WebhookSender)
    await plain.aclose()
    await hooked.aclose()


def wait_for(receiver: Receiver, count: int) -> None:
    deadline = time.monotonic() + 2
    while len(receiver.requests) < count and time.monotonic() < deadline:
        time.sleep(0.01)


def test_room_and_participant_events_reach_the_receiver(hook_settings):
    receiver = Receiver(200)

    async def factory(s):
        return await build_container(s, events=sender(s, receiver))

    with TestClient(create_app(hook_settings, container_factory=factory)) as client:
        room = create_room(client, name="Order #42", lobby_enabled=True)
        wait_for(receiver, 1)
        anya = join(client, room["code"], "Anya", room["host_secret"])
        with client.websocket_connect(f"{anya['ws_path']}?token={anya['token']}") as ws:
            ws.receive_json()
            wait_for(receiver, 2)
        wait_for(receiver, 3)

    assert receiver.events() == ["room.created", "participant.joined", "participant.left"]

    created = json.loads(receiver.requests[0].content)["data"]
    assert created["code"] == room["code"]
    assert created["name"] == "Order #42"
    assert created["lobby_enabled"] is True
    # the host secret must never leave Kolo
    assert room["host_secret"] not in receiver.requests[0].content.decode()

    joined = json.loads(receiver.requests[1].content)["data"]
    assert joined["name"] == "Anya" and joined["room"] == room["code"]


# ---------- verify_webhook on the receiver side ----------


def signed(body: bytes, secret: str = SECRET, timestamp: int | None = None) -> str:
    t = int(time.time()) if timestamp is None else timestamp
    return f"t={t},v1={sign_payload(secret, t, body)}"


BODY = b'{"event": "participant.joined"}'


def test_verify_accepts_a_fresh_signature():
    assert verify_webhook(SECRET, signed(BODY), BODY)


# lambdas: headers are built when the test runs, not at collection (time moves)
@pytest.mark.parametrize(
    "make_header",
    [
        pytest.param(lambda: signed(BODY, secret="other"), id="wrong-secret"),
        pytest.param(lambda: signed(BODY, timestamp=int(time.time()) - 301), id="replayed-old"),
        pytest.param(lambda: signed(BODY, timestamp=int(time.time()) + 301), id="from-the-future"),
        pytest.param(lambda: "", id="empty"),
        pytest.param(lambda: "garbage", id="garbage"),
        pytest.param(lambda: "t=abc,v1=00", id="bad-timestamp"),
        pytest.param(lambda: f"t={int(time.time())}", id="no-signature"),
        pytest.param(lambda: f"t={int(time.time())},v1=é", id="non-ascii"),
    ],
)
def test_verify_rejects(make_header):
    assert verify_webhook(SECRET, make_header(), BODY) is False


def test_verify_rejects_a_changed_body():
    assert not verify_webhook(SECRET, signed(BODY), BODY + b" ")


# ---------- SDK against the real app ----------


async def test_sdk_creates_and_reads_rooms(settings):
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with KoloClient("http://kolo/", transport=transport) as kolo:
            room = await kolo.create_room(name="Order #42", lobby_enabled=True)
            assert room.join_url == f"{settings.frontend_url}/r/{room.code}"
            assert room.lobby_enabled is True
            assert room.host_secret

            assert await kolo.get_room(room.code) == {
                "code": room.code,
                "name": "Order #42",
                "max_participants": 2,
                "lobby_enabled": True,
                "participants": 0,
            }

            with pytest.raises(KoloError) as missing:
                await kolo.get_room("zzz-zzzz-zzz")
            assert (missing.value.status, missing.value.code) == (404, "room_not_found")


async def test_sdk_sends_the_api_key(settings):
    settings.require_api_key = True
    settings.api_keys = [SecretStr("partner-key")]
    app = create_app(settings)

    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with KoloClient("http://kolo", transport=transport) as anonymous:
            with pytest.raises(KoloError) as refused:
                await anonymous.create_room()
            assert refused.value.status == 401

        async with KoloClient("http://kolo", api_key="partner-key", transport=transport) as partner:
            assert (await partner.create_room()).code


async def test_sdk_error_without_json_body():
    def plain_text(request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, text="Bad Gateway")

    async with KoloClient("http://kolo", transport=httpx.MockTransport(plain_text)) as kolo:
        with pytest.raises(KoloError) as failed:
            await kolo.create_room()
    error = failed.value
    assert (error.status, error.code, error.message) == (502, "http_error", "Bad Gateway")
