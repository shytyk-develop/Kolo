import pytest

pytestmark = pytest.mark.anyio


@pytest.fixture
async def caller(store):
    await store.create_user("yan_k", 1, "Yan", "en")
    for i in range(40):
        await store.create_user(f"friend{i}", 100 + i, f"F{i}", "en")
        await store.add_pair("yan_k", f"friend{i}")


async def invite(client, auth, target):
    body = {"caller": "yan_k", "caller_name": "Yan", "target": target, "room": "abc-defg-hij"}
    return await client.post("/v1/invite", headers=auth, json=body)


async def test_one_pending_invite_per_pair(client, auth, store, caller):
    assert (await invite(client, auth, "friend1")).status_code == 202
    r = await invite(client, auth, "friend1")
    assert r.status_code == 429
    assert r.json()["reason"] == "pair"
    assert 1 <= int(r.headers["retry-after"]) <= 120
    assert (await invite(client, auth, "friend2")).status_code == 202
    await store.conn.execute("update invites set created_at = created_at - interval '121 seconds'")
    assert (await invite(client, auth, "friend1")).status_code == 202


async def test_three_strangers_an_hour(client, auth, store, caller):
    # nonexistent IDs count like strangers
    for target in ("stranger1", "stranger2", "friend_of_none"):
        assert (await invite(client, auth, target)).json()["status"] == "needs_acceptance"
    r = await invite(client, auth, "stranger4")
    assert r.status_code == 429 and r.json()["reason"] == "hourly_unknown"
    assert 3500 < r.json()["retry_after"] <= 3600
    assert (await invite(client, auth, "friend1")).json()["status"] == "sent"
    await store.conn.execute(
        "update invites set created_at = now() - interval '61 minutes' where target = 'stranger1'"
    )
    assert (await invite(client, auth, "stranger4")).status_code == 202


async def test_thirty_an_hour(client, auth, store, caller):
    for i in range(30):
        assert (await invite(client, auth, f"friend{i}")).status_code == 202, i
    r = await invite(client, auth, "friend30")
    assert r.status_code == 429 and r.json()["reason"] == "hourly"
    # limits are per caller
    await store.create_user("alex718", 2, "Alex", "en")
    await store.add_pair("alex718", "friend30")
    body = {"caller": "alex718", "caller_name": "Alex", "target": "friend30", "room": "abc-defg-hij"}
    assert (await client.post("/v1/invite", headers=auth, json=body)).status_code == 202


async def test_limits_hold_under_concurrency(client, auth, store, caller):
    import asyncio

    results = await asyncio.gather(*(invite(client, auth, f"nobody{i}") for i in range(8)))
    assert sorted(r.status_code for r in results) == [202] * 3 + [429] * 5
