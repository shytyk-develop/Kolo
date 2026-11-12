import pytest

pytestmark = pytest.mark.anyio


async def test_health_needs_no_key(client):
    r = await client.get("/health")
    assert r.status_code == 200 and r.json() == {"status": "ok"}


@pytest.mark.parametrize(
    ("method", "path"),
    [("post", "/v1/link"), ("get", "/v1/link/abcdefghijklmnopqrstuvwx"), ("post", "/v1/invite"),
     ("post", "/v1/invite/00000000-0000-0000-0000-000000000000/ended"), ("post", "/v1/calls/completed"),
     ("delete", "/v1/users/alex718")],
)
@pytest.mark.parametrize("key", [None, "", "wrong", "test-api-key-0123456789abcdeX"])
async def test_api_needs_the_key(client, method, path, key):
    headers = {} if key is None else {"X-Api-Key": key}
    r = await client.request(method, path, headers=headers, json={})
    assert r.status_code == 401


async def test_misconfigured_service_says_so(store, tg):
    import httpx

    from notify.app import create_app

    app = create_app(None)  # reads the env, emptied below
    import os

    saved = {k: os.environ.pop(k) for k in list(os.environ) if k in ("BOT_TOKEN", "DATABASE_URL")}
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/health")
            assert r.status_code == 503 and r.json()["status"] == "misconfigured"
            assert "BOT_TOKEN is not set" in r.json()["problems"]
            r = await c.post("/v1/link", headers={"X-Api-Key": "x"})
            assert r.status_code == 503
    finally:
        os.environ.update(saved)


async def test_link_flow(client, auth, tg):
    from tests.conftest import message_update, send_update

    r = await client.post("/v1/link", headers=auth)
    assert r.status_code == 201
    body = r.json()
    token = body["token"]
    assert body["deep_link"] == f"https://t.me/kolo_test_bot?start=link_{token}"
    assert body["expires_in"] == 600
    assert (await client.get(f"/v1/link/{token}", headers=auth)).json() == {
        "status": "pending", "handle": None, "display_name": None
    }

    await send_update(client, message_update(501, f"/start link_{token}", first_name="Yan"))
    await send_update(client, message_update(501, "yan_k", first_name="Yan"))
    assert "Linked to Kolo" in tg.named("SendMessage")[-1].text
    assert (await client.get(f"/v1/link/{token}", headers=auth)).json() == {
        "status": "linked", "handle": "yan_k", "display_name": "Yan"
    }
    # single use
    await send_update(client, message_update(502, f"/start link_{token}"))
    bad, greeting = tg.named("SendMessage")[-2:]
    assert "expired or was already used" in bad.text and "Pick a short Kolo ID" in greeting.text
    assert (await client.get(f"/v1/link/{token}", headers=auth)).json()["handle"] == "yan_k"


async def test_link_token_expires(client, auth, store):
    token = (await client.post("/v1/link", headers=auth)).json()["token"]
    await store.conn.execute("update link_tokens set expires_at = now() - interval '1 second'")
    assert (await client.get(f"/v1/link/{token}", headers=auth)).json()["status"] == "expired"
    assert (await client.get("/v1/link/nope-nope-nope-nope-nope", headers=auth)).status_code == 404


async def test_existing_user_links_right_away(client, auth, tg, store):
    from tests.conftest import message_update, send_update

    await store.create_user("alex718", 601, "Alex", "en")
    token = (await client.post("/v1/link", headers=auth)).json()["token"]
    await send_update(client, message_update(601, f"/start link_{token}"))
    assert "Kolo now knows your ID <code>alex718</code>" in tg.named("SendMessage")[-1].text
    assert (await client.get(f"/v1/link/{token}", headers=auth)).json()["status"] == "linked"


async def test_calls_completed_and_delete(client, auth, store):
    await store.create_user("alex718", 1, "Alex", "en")
    await store.create_user("yan_k", 2, "Yan", "en")
    r = await client.post("/v1/calls/completed", headers=auth, json={"a": "Yan_K", "b": "@alex718"})
    assert r.status_code == 204
    assert await store.is_known("alex718", "yan_k")
    for b, status in (("yan_k", 204), ("ghost", 204), ("alex718", 422)):
        r = await client.post("/v1/calls/completed", headers=auth, json={"a": "alex718", "b": b})
        assert r.status_code == status, b

    assert (await client.delete("/v1/users/yan_k", headers=auth)).status_code == 204
    assert await store.user("yan_k") is None
    assert not await store.is_known("alex718", "yan_k")
    assert (await client.delete("/v1/users/yan_k", headers=auth)).status_code == 204
    assert (await client.delete("/v1/users/no!", headers=auth)).status_code == 422
