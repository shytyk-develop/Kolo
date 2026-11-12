import uuid

import pytest
from aiogram.types import InlineKeyboardMarkup

from notify.signing import verify
from notify.texts import plain, t

pytestmark = pytest.mark.anyio

YAN, ALEX = 1001, 1002


@pytest.fixture
async def people(store):
    await store.create_user("yan_k", YAN, "Yan", "en")
    await store.create_user("alex718", ALEX, "Alex", "ru")


async def invite(client, auth, target="alex718", caller="yan_k", name="Yan", room="abc-defg-hij"):
    body = {"caller": caller, "caller_name": name, "target": target, "room": room}
    return await client.post("/v1/invite", headers=auth, json=body)


def buttons(markup: InlineKeyboardMarkup) -> list[list[dict]]:
    return [[b.model_dump(exclude_none=True) for b in row] for row in markup.inline_keyboard]


async def test_known_pair_gets_the_full_invite(client, auth, tg, store, people, settings):
    await store.add_pair("yan_k", "alex718")
    r = await invite(client, auth)
    assert r.status_code == 202
    assert r.json()["status"] == "sent"
    [sent] = tg.named("SendMessage")
    assert sent.chat_id == ALEX
    assert sent.text == t("ru", "invite", name="Yan", code="abc-defg-hij")
    assert sent.text.endswith("<code>abc-defg-hij</code>")
    [[join], [open_link, copy]] = buttons(sent.reply_markup)
    room = "https://kolo-black.vercel.app/r/abc-defg-hij"
    assert join["web_app"]["url"].startswith("https://notify.example/open?u=")
    assert open_link["url"] == room
    assert copy["copy_text"]["text"] == room
    from urllib.parse import parse_qs, urlsplit

    q = parse_qs(urlsplit(join["web_app"]["url"]).query)
    assert q["u"] == [room] and verify(settings.api_key, room, q["s"][0], settings.kolo_url)

    saved = await store.invite(r.json()["invite_id"])
    assert (saved.status, saved.chat_id, saved.message_id) == ("sent", ALEX, 101)


async def test_stranger_must_accept_first(client, auth, tg, store, people):
    r = await invite(client, auth, name="Yan <script>")
    assert r.json()["status"] == "needs_acceptance"
    [sent] = tg.named("SendMessage")
    assert "Yan &lt;script&gt;" in sent.text and "<script>" not in sent.text
    assert sent.text == t("ru", "invite_unknown", name="Yan <script>")
    # no room until accepted
    assert "abc-defg-hij" not in sent.text
    [[accept, block]] = buttons(sent.reply_markup)
    invite_id = r.json()["invite_id"]
    assert accept["callback_data"] == f"acc:{invite_id}"
    assert block == {"text": plain("ru", "btn_block", name="Yan <script>"), "callback_data": f"blk:{invite_id}"}


async def test_unknown_id_looks_like_a_stranger(client, auth, tg, store, people):
    r = await invite(client, auth, target="nobody_here")
    assert r.status_code == 202 and r.json()["status"] == "needs_acceptance"
    assert tg.calls == []
    assert (await store.invite(r.json()["invite_id"])).status == "void"


async def test_blocked_caller_looks_like_a_stranger(client, auth, tg, store, people):
    await store.add_block("alex718", "yan_k")
    r = await invite(client, auth)
    assert r.status_code == 202 and r.json()["status"] == "needs_acceptance"
    assert tg.calls == []


async def test_blocked_known_pair_looks_sent(client, auth, tg, store, people):
    await store.add_pair("yan_k", "alex718")
    await store.add_block("alex718", "yan_k")
    r = await invite(client, auth)
    assert r.json()["status"] == "sent"
    assert tg.calls == []


async def test_bot_blocked_by_target(client, auth, tg, store, people):
    await store.add_pair("yan_k", "alex718")
    tg.blocked_chats.add(ALEX)
    r = await invite(client, auth)
    assert r.status_code == 202 and r.json()["status"] == "undeliverable"
    assert (await store.user("alex718")).bot_blocked
    assert (await store.invite(r.json()["invite_id"])).status == "undeliverable"
    # back to the bot: unmarked
    from tests.conftest import message_update, send_update

    await send_update(client, message_update(ALEX, "/start", lang="ru"))
    assert not (await store.user("alex718")).bot_blocked


async def test_bot_blocked_by_a_stranger_stays_hidden(client, auth, tg, store, people):
    tg.blocked_chats.add(ALEX)
    r = await invite(client, auth)
    assert r.json()["status"] == "needs_acceptance"
    assert (await store.user("alex718")).bot_blocked


async def test_telegram_down(client, auth, tg, store, people):
    tg.down = True
    r = await invite(client, auth)
    assert r.json()["status"] == "needs_acceptance"  # stranger: same answer as always
    await store.add_pair("yan_k", "alex718")
    r = await invite(client, auth, target="alex718", room="xyz-defg-hij")
    assert r.status_code == 429  # the invite above still holds the pair
    await store.conn.execute("delete from invites")
    r = await invite(client, auth)
    assert r.status_code == 502
    # a failed known-pair invite doesn't hold the pair
    tg.down = False
    assert (await invite(client, auth)).json()["status"] == "sent"


@pytest.mark.parametrize(
    "body",
    [
        {"caller": "yan_k", "caller_name": "Yan", "target": "alex718", "room": "ABC-DEFG-HIJ"},
        {"caller": "yan_k", "caller_name": "Yan", "target": "alex718", "room": "https://evil/r/abc"},
        {"caller": "yan_k", "caller_name": "Yan", "target": "yan_k", "room": "abc-defg-hij"},
        {"caller": "yan_k", "caller_name": "   ", "target": "alex718", "room": "abc-defg-hij"},
        {"caller": "yan_k", "caller_name": "Y" * 41, "target": "alex718", "room": "abc-defg-hij"},
        {"caller": "yan k", "caller_name": "Yan", "target": "alex718", "room": "abc-defg-hij"},
        {"caller": "yan_k", "caller_name": "Yan", "target": "a", "room": "abc-defg-hij"},
    ],
)
async def test_bad_requests(client, auth, tg, people, body):
    assert (await client.post("/v1/invite", headers=auth, json=body)).status_code == 422
    assert tg.calls == []


async def test_caller_must_be_a_kolo_id(client, auth, tg, people):
    r = await invite(client, auth, caller="ghost_caller")
    assert r.status_code == 422
    assert tg.calls == []


async def test_names_are_one_line(client, auth, tg, store, people):
    await store.add_pair("yan_k", "alex718")
    await invite(client, auth, name="Yan\n\nKolo support:\tclick")
    assert "<b>Yan Kolo support: click</b>" in tg.named("SendMessage")[0].text


async def test_ended_invite(client, auth, tg, store, people):
    await store.add_pair("yan_k", "alex718")
    invite_id = (await invite(client, auth)).json()["invite_id"]
    r = await client.post(f"/v1/invite/{invite_id}/ended", headers=auth)
    assert r.status_code == 200 and r.json() == {"invite_id": invite_id, "status": "ended"}
    [edit] = tg.named("EditMessageText")
    assert (edit.chat_id, edit.message_id) == (ALEX, 101)
    assert edit.text == t("ru", "ended", name="Yan")
    assert edit.reply_markup is None
    assert (await client.post(f"/v1/invite/{invite_id}/ended", headers=auth)).status_code == 200
    assert len(tg.named("EditMessageText")) == 1
    assert (await client.post(f"/v1/invite/{uuid.uuid4()}/ended", headers=auth)).status_code == 404
    assert (await client.post("/v1/invite/not-a-uuid/ended", headers=auth)).status_code == 422


async def test_ending_frees_the_pair(client, auth, store, people):
    first = (await invite(client, auth)).json()["invite_id"]
    assert (await invite(client, auth)).status_code == 429
    await client.post(f"/v1/invite/{first}/ended", headers=auth)
    assert (await invite(client, auth)).status_code == 202
