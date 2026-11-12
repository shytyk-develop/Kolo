import pytest

from notify.texts import t
from tests.conftest import callback_update, message_update, send_update

pytestmark = pytest.mark.anyio

ME = 777


def last(tg):
    return tg.named("SendMessage")[-1].text


async def test_webhook_needs_the_secret(client, tg):
    for headers in ({}, {"X-Telegram-Bot-Api-Secret-Token": "wrong"}):
        r = await client.post("/telegram/webhook", json=message_update(ME, "/start"), headers=headers)
        assert r.status_code == 403
    assert tg.calls == []


async def test_choosing_an_id(client, tg, store):
    await send_update(client, message_update(ME, "/start"))
    assert last(tg) == t("en", "greet") + "\n\n" + t("en", "ask_id")

    await send_update(client, message_update(ME, "no"))
    assert "won't work as an ID" in last(tg)
    await send_update(client, message_update(ME, "kolo_admin"))
    assert "<code>kolo_admin</code> is reserved" in last(tg)
    await store.create_user("taken1", 1, "Someone", "en")
    await send_update(client, message_update(ME, "Taken1"))
    assert "<code>taken1</code> is already taken" in last(tg)

    await send_update(client, message_update(ME, " @Alex718 "))
    assert last(tg) == "Your Kolo ID: <code>alex718</code> — share it with friends."
    me = await store.user("alex718")
    assert (me.chat_id, me.display_name, me.lang) == (ME, "Alex", "en")
    assert await store.state(ME) is None

    await send_update(client, message_update(ME, "other_id"))
    assert "/rename" in last(tg)
    assert await store.user("other_id") is None


async def test_language_follows_telegram(client, tg):
    for chat, lang, shown in ((ME, "de", "de"), (ME + 1, "uk", "uk"), (ME + 2, "ru-RU", "ru"), (ME + 3, "ja", "en")):
        await send_update(client, message_update(chat, "/start", lang=lang))
        assert last(tg).startswith(t(shown, "greet")), lang


async def test_names_from_telegram_are_escaped(client, tg, store):
    await send_update(client, message_update(ME, "/start", first_name="<i>Eve</i>"))
    await send_update(client, message_update(ME, "eve_1", first_name="<i>Eve</i>"))
    # stored as is, escaped when shown
    assert (await store.user("eve_1")).display_name == "<i>Eve</i>"


async def test_id_and_rename(client, tg, store):
    await send_update(client, message_update(ME, "/id"))
    assert "don't have a Kolo ID yet" in last(tg)
    await send_update(client, message_update(ME, "alex718"))
    await store.create_user("yan_k", 1, "Yan", "en")
    await store.add_pair("alex718", "yan_k")
    await store.add_block("alex718", "yan_k")

    await send_update(client, message_update(ME, "/rename"))
    assert "Your Kolo ID is <code>alex718</code>. Send the new one" in last(tg)
    await send_update(client, message_update(ME, "yan_k"))
    assert "already taken" in last(tg)
    await send_update(client, message_update(ME, "alex_new"))
    assert "<code>alex_new</code> — the old one no longer works" in last(tg)
    assert await store.user("alex718") is None
    # pairs and blocks follow the rename
    assert await store.is_known("alex_new", "yan_k")
    assert await store.is_blocked("alex_new", "yan_k")
    await send_update(client, message_update(ME, "/id"))
    assert "<code>alex_new</code>" in last(tg)


async def test_stop_deletes_everything(client, auth, tg, store):
    await send_update(client, message_update(ME, "/start"))
    await send_update(client, message_update(ME, "alex718"))
    await store.create_user("yan_k", 1, "Yan", "en")
    await store.add_pair("alex718", "yan_k")
    body = {"caller": "yan_k", "caller_name": "Yan", "target": "alex718", "room": "abc-defg-hij"}
    await client.post("/v1/invite", headers=auth, json=body)

    await send_update(client, message_update(ME, "/stop"))
    ask = tg.named("SendMessage")[-1]
    assert "can't be undone" in ask.text
    [[yes, no]] = ask.reply_markup.inline_keyboard
    assert (yes.callback_data, no.callback_data) == ("stop:yes", "stop:no")

    await send_update(client, callback_update(ME, "stop:no", 9))
    assert tg.named("EditMessageText")[-1].text == "Nothing was deleted."
    assert await store.user("alex718") is not None

    for _ in range(2):  # pressed twice
        r = await send_update(client, callback_update(ME, "stop:yes", 9))
        assert r.status_code == 200
        assert tg.named("EditMessageText")[-1].text.startswith("Deleted.")
    assert await store.user("alex718") is None
    assert not await store.is_known("alex718", "yan_k")
    assert await store.conn.fetchval("select count(*) from invites") == 0
    assert len(tg.named("AnswerCallbackQuery")) == 3

    await send_update(client, message_update(ME, "/stop"))
    assert "keeps nothing about you" in last(tg)


async def stranger_invite(client, auth, store, tg):
    await store.create_user("yan_k", 1, "Yan", "en")
    await store.create_user("alex718", ME, "Alex", "en")
    body = {"caller": "yan_k", "caller_name": "Yan", "target": "alex718", "room": "abc-defg-hij"}
    invite_id = (await client.post("/v1/invite", headers=auth, json=body)).json()["invite_id"]
    return invite_id, tg.named("SendMessage")[-1]


async def test_accept_turns_it_into_the_invite(client, auth, tg, store):
    invite_id, _ = await stranger_invite(client, auth, store, tg)
    for _ in range(2):  # idempotent
        await send_update(client, callback_update(ME, f"acc:{invite_id}", 101))
        edit = tg.named("EditMessageText")[-1]
        assert edit.text == "📞 <b>Yan</b> invites you to a call\nCode: <code>abc-defg-hij</code>"
        assert edit.reply_markup.inline_keyboard[0][0].web_app is not None
        assert tg.named("AnswerCallbackQuery")[-1].text == "Accepted"
    assert await store.is_known("yan_k", "alex718")
    assert (await store.invite(invite_id)).status == "sent"
    await store.conn.execute("update invites set created_at = now() - interval '1 hour'")
    body = {"caller": "yan_k", "caller_name": "Yan", "target": "alex718", "room": "xyz-defg-hij"}
    assert (await client.post("/v1/invite", headers=auth, json=body)).json()["status"] == "sent"


async def test_block(client, auth, tg, store):
    invite_id, _ = await stranger_invite(client, auth, store, tg)
    await send_update(client, callback_update(ME, f"blk:{invite_id}", 101))
    assert tg.named("EditMessageText")[-1].text == "🚫 Blocked. You won't get calls from Yan."
    assert tg.named("EditMessageText")[-1].reply_markup is None
    assert tg.named("AnswerCallbackQuery")[-1].text == "Blocked"
    assert await store.is_blocked("alex718", "yan_k")
    assert not await store.is_known("alex718", "yan_k")
    sent_before = len(tg.named("SendMessage"))
    await store.conn.execute("update invites set created_at = now() - interval '1 hour'")
    body = {"caller": "yan_k", "caller_name": "Yan", "target": "alex718", "room": "xyz-defg-hij"}
    assert (await client.post("/v1/invite", headers=auth, json=body)).json()["status"] == "needs_acceptance"
    assert len(tg.named("SendMessage")) == sent_before


async def test_buttons_after_the_call_ended(client, auth, tg, store):
    invite_id, _ = await stranger_invite(client, auth, store, tg)
    await client.post(f"/v1/invite/{invite_id}/ended", headers=auth)
    await send_update(client, callback_update(ME, f"acc:{invite_id}", 101))
    assert tg.named("AnswerCallbackQuery")[-1].text == "This call has ended"
    assert not await store.is_known("yan_k", "alex718")


async def test_buttons_only_work_for_the_recipient(client, auth, tg, store):
    invite_id, _ = await stranger_invite(client, auth, store, tg)
    await store.create_user("mallory", 999, "M", "en")
    await send_update(client, callback_update(999, f"acc:{invite_id}", 101))
    assert tg.named("AnswerCallbackQuery")[-1].text == "This invite is no longer available"
    assert not await store.is_known("yan_k", "alex718")
    # junk data: still answered
    await send_update(client, callback_update(ME, "acc:not-a-uuid", 101))
    await send_update(client, callback_update(ME, "whatever", 101))
    assert len(tg.named("AnswerCallbackQuery")) == 3


async def test_a_failing_update_still_gets_200(client, tg, monkeypatch):
    from notify.store import Store

    async def broken(*_):
        raise RuntimeError("db went away")

    monkeypatch.setattr(Store, "user_by_chat", broken)
    r = await send_update(client, message_update(ME, "/start"))
    assert r.status_code == 200


async def test_groups_are_ignored(client, tg):
    update = message_update(-100123, "/start")
    update["message"]["chat"]["type"] = "group"
    await send_update(client, update)
    assert tg.named("SendMessage") == []
