import json
import time
from collections.abc import Callable

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from kolo.container import build_container
from kolo.core.tg_cookie import COOKIE, Linked, read_linked, sign_linked
from kolo.main import create_app
from tests.conftest import create_room, join

SESSION_SECRET = "session-secret-for-tests-0123456789abcdef"
NOTIFY_KEY = "notify-key-for-tests-0123456789"


class FakeNotify:
    """Stands in for the notify service: records calls, answers what a test sets."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict | None]] = []
        self.link_state: dict = {"status": "pending", "handle": None, "display_name": None}
        self.invite_answer: tuple[int, dict] = (202, {"invite_id": "inv-1", "status": "sent"})
        self.fail: Callable[[httpx.Request], httpx.Response | None] = lambda request: None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, request.url.path, body))
        assert request.headers["x-api-key"] == NOTIFY_KEY
        if (failed := self.fail(request)) is not None:
            return failed
        path = request.url.path
        if path == "/v1/link":
            return httpx.Response(201, json={"token": "tok_abcdefghijklmnop", "expires_in": 600,
                                             "deep_link": "https://t.me/kolo_bot?start=link_tok_abcdefghijklmnop"})
        if path.startswith("/v1/link/"):
            return httpx.Response(200, json=self.link_state)
        if path == "/v1/invite":
            status, answer = self.invite_answer
            return httpx.Response(status, json=answer)
        if path.endswith("/ended"):
            return httpx.Response(200, json={"status": "ended"})
        return httpx.Response(204)

    def paths(self, method: str | None = None) -> list[str]:
        return [path for m, path, _ in self.calls if method in (None, m)]

    def wait_for(self, path: str, timeout: float = 3.0) -> dict | None:
        """Background calls land a moment later."""
        until = time.time() + timeout
        while time.time() < until:
            for _, called, body in self.calls:
                if called == path:
                    return body or {}
            time.sleep(0.02)
        raise AssertionError(f"notify never got {path}: {self.paths()}")


@pytest.fixture
def notify() -> FakeNotify:
    return FakeNotify()


@pytest.fixture
def tg_settings(settings):
    return settings.model_copy(
        update={
            "notify_url": "https://notify.test",
            "notify_api_key": SecretStr(NOTIFY_KEY),
            "session_secret": SecretStr(SESSION_SECRET),
        }
    )


@pytest.fixture
def tg_client(tg_settings, notify, events):
    async def factory(s):
        return await build_container(s, events=events, notify_transport=httpx.MockTransport(notify))

    with TestClient(create_app(tg_settings, container_factory=factory)) as test_client:
        yield test_client


def cookie_for(handle: str, name: str = "") -> str:
    return sign_linked(SESSION_SECRET, Linked(handle, name or handle.title()))


def cleared(response: httpx.Response) -> bool:
    headers = response.headers.get_list("set-cookie")
    return any(h.startswith(f"{COOKIE}=") and "Max-Age=0" in h for h in headers)


def as_linked(client: TestClient, handle: str | None) -> None:
    client.cookies.clear()
    if handle:
        client.cookies.set(COOKIE, cookie_for(handle))


# ---------- the cookie ----------


def test_cookie_roundtrip_and_tampering():
    value = cookie_for("alex718", "Alex")
    assert read_linked(SESSION_SECRET, value) == Linked("alex718", "Alex")
    body, mac = value.split(".")
    assert read_linked("another-secret-0123456789abcdef0123", value) is None
    assert read_linked(SESSION_SECRET, body + "." + mac[:-2] + "xx") is None
    assert read_linked(SESSION_SECRET, value + "x") is None
    assert read_linked(SESSION_SECRET, "nonsense") is None
    assert read_linked(SESSION_SECRET, None) is None
    old = sign_linked(SESSION_SECRET, Linked("alex718", "Alex"), now=time.time() - 200 * 24 * 3600)
    assert read_linked(SESSION_SECRET, old) is None


def test_cookie_with_a_bad_handle_is_refused():
    assert read_linked(SESSION_SECRET, sign_linked(SESSION_SECRET, Linked("Bad Handle", "x"))) is None


# ---------- off by default ----------


def test_telegram_off_without_config(client):
    assert client.get("/api/v1/me").json() == {"telegram": False}
    r = client.post("/api/v1/me/telegram/link")
    assert r.status_code == 503 and r.json()["error"]["code"] == "telegram_disabled"
    code = create_room(client)["code"]
    assert client.post(f"/api/v1/rooms/{code}/invite", json={"target": "alex718"}).status_code == 503


def test_half_config_is_off(settings):
    assert not settings.model_copy(update={"notify_url": "https://notify.test"}).telegram_enabled


# ---------- linking ----------


def test_link_flow(tg_client, notify):
    assert tg_client.get("/api/v1/me").json() == {"telegram": True}

    r = tg_client.post("/api/v1/me/telegram/link")
    assert r.status_code == 200
    assert r.json() == {
        "token": "tok_abcdefghijklmnop",
        "deep_link": "https://t.me/kolo_bot?start=link_tok_abcdefghijklmnop",
        "expires_in": 600,
    }
    set_cookie = r.headers["set-cookie"]
    assert "kolo_tg_link=" in set_cookie and "HttpOnly" in set_cookie and "SameSite=lax" in set_cookie

    status = tg_client.get("/api/v1/me/telegram/link/tok_abcdefghijklmnop")
    assert status.json() == {"status": "pending"}
    assert COOKIE not in tg_client.cookies

    notify.link_state = {"status": "linked", "handle": "alex718", "display_name": "Alex Smith"}
    status = tg_client.get("/api/v1/me/telegram/link/tok_abcdefghijklmnop")
    assert status.json() == {"status": "linked", "handle": "alex718"}
    assert read_linked(SESSION_SECRET, tg_client.cookies[COOKIE]) == Linked("alex718", "Alex Smith")
    assert tg_client.get("/api/v1/me").json() == {"telegram": True, "handle": "alex718"}


def test_only_the_browser_that_asked_can_collect_the_link(tg_client, notify):
    tg_client.post("/api/v1/me/telegram/link")
    tg_client.cookies.clear()
    notify.link_state = {"status": "linked", "handle": "alex718", "display_name": "Alex"}
    r = tg_client.get("/api/v1/me/telegram/link/tok_abcdefghijklmnop")
    assert r.status_code == 403 and r.json()["error"]["code"] == "link_other_browser"
    assert COOKIE not in tg_client.cookies
    # notify wasn't even asked
    assert "/v1/link/tok_abcdefghijklmnop" not in notify.paths()


def test_tampered_cookie_is_dropped(tg_client):
    tg_client.cookies.set(COOKIE, cookie_for("alex718")[:-3] + "abc")
    r = tg_client.get("/api/v1/me")
    assert r.json() == {"telegram": True}
    assert cleared(r)


def test_unlink(tg_client, notify):
    as_linked(tg_client, "alex718")
    notify.fail = lambda request: httpx.Response(500) if request.method == "DELETE" else None
    r = tg_client.delete("/api/v1/me/telegram")
    assert r.status_code == 503 and not cleared(r)  # kept: they can retry

    notify.fail = lambda request: None
    r = tg_client.delete("/api/v1/me/telegram")
    assert r.status_code == 204 and cleared(r)
    assert ("DELETE", "/v1/users/alex718", None) in notify.calls


# ---------- inviting ----------


def test_invite_needs_a_linked_browser(tg_client, notify):
    code = create_room(tg_client)["code"]
    r = tg_client.post(f"/api/v1/rooms/{code}/invite", json={"target": "alex718"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "telegram_not_linked"
    assert notify.calls == []


def test_invite_takes_the_caller_from_the_cookie(tg_client, notify):
    code = create_room(tg_client)["code"]
    as_linked(tg_client, "yan_k")
    # whatever the body says about the caller is ignored
    body = {"target": "@Alex718", "caller": "someone_else", "caller_name": "Admin"}
    r = tg_client.post(f"/api/v1/rooms/{code}/invite", json=body)
    assert r.status_code == 200 and r.json() == {"status": "sent"}
    assert notify.calls[-1] == (
        "POST", "/v1/invite", {"caller": "yan_k", "caller_name": "Yan_K", "target": "alex718", "room": code}
    )


@pytest.mark.parametrize("status", ["needs_acceptance", "undeliverable"])
def test_invite_passes_the_status_through(tg_client, notify, status):
    code = create_room(tg_client)["code"]
    as_linked(tg_client, "yan_k")
    notify.invite_answer = (202, {"invite_id": "inv-2", "status": status})
    r = tg_client.post(f"/api/v1/rooms/{code}/invite", json={"target": "alex718"})
    assert r.json() == {"status": status}


@pytest.mark.parametrize("target", ["ab", "alex-718", "a" * 21, "yan_k", "@YAN_K"])
def test_invite_checks_the_target(tg_client, notify, target):
    code = create_room(tg_client)["code"]
    as_linked(tg_client, "yan_k")
    r = tg_client.post(f"/api/v1/rooms/{code}/invite", json={"target": target})
    assert r.status_code == 422
    assert notify.calls == []


def test_invite_to_a_missing_room(tg_client, notify):
    as_linked(tg_client, "yan_k")
    r = tg_client.post("/api/v1/rooms/zzz-zzzz-zzz/invite", json={"target": "alex718"})
    assert r.status_code == 404
    assert notify.calls == []


def test_notify_rate_limit(tg_client, notify):
    code = create_room(tg_client)["code"]
    as_linked(tg_client, "yan_k")
    notify.invite_answer = (429, {"detail": "too many invites", "reason": "pair", "retry_after": 87})
    r = tg_client.post(f"/api/v1/rooms/{code}/invite", json={"target": "alex718"})
    assert r.status_code == 429
    assert r.json()["error"]["code"] == "invite_rate_limited"
    assert r.json()["error"]["message"] == "Too many invites, try again later"
    assert r.headers["retry-after"] == "87"


def test_notify_forgot_the_caller(tg_client, notify):
    code = create_room(tg_client)["code"]
    as_linked(tg_client, "yan_k")
    notify.invite_answer = (422, {"detail": "caller is not a Kolo ID"})
    r = tg_client.post(f"/api/v1/rooms/{code}/invite", json={"target": "alex718"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "telegram_not_linked"
    assert cleared(r)


@pytest.mark.parametrize(
    "failure",
    [
        lambda request: httpx.Response(502, json={"detail": "telegram"}),
        lambda request: httpx.Response(401),
        lambda request: (_ for _ in ()).throw(httpx.ConnectTimeout("slow")),
        lambda request: (_ for _ in ()).throw(httpx.ConnectError("down")),
    ],
)
def test_notify_trouble_is_friendly(tg_client, notify, failure):
    code = create_room(tg_client)["code"]
    as_linked(tg_client, "yan_k")
    notify.fail = failure
    r = tg_client.post(f"/api/v1/rooms/{code}/invite", json={"target": "alex718"})
    assert r.status_code == 503
    assert r.json()["error"] == {
        "code": "telegram_unavailable", "message": "Telegram isn't answering. Try again in a moment."
    }


# ---------- in the call ----------


def ws_url(ticket: dict) -> str:
    return f"{ticket['ws_path']}?token={ticket['token']}"


def test_handles_come_only_from_the_cookie(tg_client):
    room = create_room(tg_client)
    as_linked(tg_client, "yan_k")
    anya = join(tg_client, room["code"], "Yan", room["host_secret"])
    as_linked(tg_client, None)
    body = {"display_name": "Bob", "handle": "admin", "client_id": "browser-bob-0001"}
    bob = tg_client.post(f"/api/v1/rooms/{room['code']}/join", json=body).json()

    with tg_client.websocket_connect(ws_url(anya)) as ws_a:
        assert ws_a.receive_json()["you"]["handle"] == "yan_k"
        with tg_client.websocket_connect(ws_url(bob)) as ws_b:
            welcome = ws_b.receive_json()
            assert welcome["peers"][0]["handle"] == "yan_k"
            assert "handle" not in welcome["you"]
            assert "handle" not in ws_a.receive_json()["peer"]


def test_call_end_tells_notify(tg_client, notify):
    room = create_room(tg_client)
    code = room["code"]
    as_linked(tg_client, "yan_k")
    tg_client.post(f"/api/v1/rooms/{code}/invite", json={"target": "alex718"})
    yan = join(tg_client, code, "Yan", room["host_secret"])
    as_linked(tg_client, "alex718")
    alex = join(tg_client, code, "Alex")

    with tg_client.websocket_connect(ws_url(yan)) as ws_y:
        ws_y.receive_json()
        with tg_client.websocket_connect(ws_url(alex)) as ws_a:
            ws_a.receive_json()
            ws_y.receive_json()
        assert ws_y.receive_json()["type"] == "peer-left"

    assert notify.wait_for("/v1/calls/completed") == {"a": "alex718", "b": "yan_k"}
    notify.wait_for("/v1/invite/inv-1/ended")
    # once: the second leave (room empty) has no call to end
    time.sleep(0.2)
    assert notify.paths().count("/v1/invite/inv-1/ended") == 1
    assert notify.paths().count("/v1/calls/completed") == 1


def test_no_completed_call_without_two_handles(tg_client, notify):
    room = create_room(tg_client)
    as_linked(tg_client, "yan_k")
    yan = join(tg_client, room["code"], "Yan", room["host_secret"])
    as_linked(tg_client, None)
    bob = join(tg_client, room["code"], "Bob")
    with tg_client.websocket_connect(ws_url(yan)) as ws_y:
        ws_y.receive_json()
        with tg_client.websocket_connect(ws_url(bob)) as ws_b:
            ws_b.receive_json()
            ws_y.receive_json()
        ws_y.receive_json()
    time.sleep(0.2)
    assert "/v1/calls/completed" not in notify.paths()


async def test_expired_rooms_end_their_invites(tg_settings, notify):
    from datetime import UTC, datetime, timedelta

    c = await build_container(tg_settings, notify_transport=httpx.MockTransport(notify))
    try:
        live = (await c.rooms.create_room()).room
        old = (await c.rooms.create_room()).room
        await c.repo.add_invite(live.code, "inv-live")
        await c.repo.add_invite(old.code, "inv-old")
        # the old room ran out
        from dataclasses import replace

        c.repo._inner._rooms[old.code] = replace(old, expires_at=datetime.now(UTC) - timedelta(seconds=1))
        await c.telegram.end_expired_invites()
        assert notify.paths() == ["/v1/invite/inv-old/ended"]
        assert await c.repo.take_invites(live.code) == ["inv-live"]
    finally:
        await c.aclose()


# ---------- behind the frontend's /api proxy ----------


def test_cookie_is_host_only_and_secure_behind_an_https_proxy(tg_client, notify):
    headers = {"X-Forwarded-Proto": "https", "X-Forwarded-Host": "kolo-black.vercel.app"}
    r = tg_client.post("/api/v1/me/telegram/link", headers=headers)
    cookie = r.headers["set-cookie"]
    assert "Secure" in cookie and "HttpOnly" in cookie and "SameSite=lax" in cookie
    assert "Domain" not in cookie and "Path=/" in cookie
    assert r.headers["cache-control"] == "no-store"
    # plain http dev: no Secure, or Safari drops it on localhost
    assert "Secure" not in tg_client.post("/api/v1/me/telegram/link").headers["set-cookie"]


def test_me_is_never_cached(tg_client):
    assert tg_client.get("/api/v1/me").headers["cache-control"] == "no-store"


def test_client_ip_from_the_proxy_only_when_trusted(tg_settings, events):
    from kolo.api.deps import client_ip

    class Req:
        def __init__(self, trust: bool) -> None:
            self.headers = {"x-forwarded-for": "203.0.113.7, 10.0.0.1"}
            self.client = type("C", (), {"host": "76.76.21.21"})()
            settings = tg_settings.model_copy(update={"trust_proxy": trust})
            container = type("K", (), {"settings": settings})
            self.app = type("A", (), {"state": type("S", (), {"container": container})})

    assert client_ip(Req(trust=False)) == "76.76.21.21"
    assert client_ip(Req(trust=True)) == "203.0.113.7"
