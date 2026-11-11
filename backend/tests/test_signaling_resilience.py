"""A call has to survive real life: ICE bursts, quiet tabs, short network drops."""
import time

from fastapi.testclient import TestClient

from kolo.container import build_container
from kolo.main import create_app
from tests.conftest import create_room, join


def ws_url(ticket: dict) -> str:
    return f"{ticket['ws_path']}?token={ticket['token']}"


def until_pong(ws) -> list[dict]:
    """Ping, then read until the pong: everything that was queued before it."""
    ws.send_json({"type": "ping"})
    seen = []
    while True:
        message = ws.receive_json()
        if message["type"] == "pong":
            return seen
        seen.append(message)


def connect_pair(client, room):
    a = join(client, room["code"], "A", room["host_secret"])
    b = join(client, room["code"], "B")
    return a, b


# ---------- connecting fast ----------


def test_an_ice_burst_right_after_the_offer_all_gets_through(client):
    # trickle ICE sends an offer and a burst of candidates within milliseconds
    room = create_room(client)
    a, b = connect_pair(client, room)
    with client.websocket_connect(ws_url(a)) as ws_a, client.websocket_connect(ws_url(b)) as ws_b:
        ws_a.receive_json(), ws_b.receive_json(), ws_a.receive_json()
        ws_b.send_json({"type": "offer", "to": a["participant_id"], "sdp": "v=0"})
        for i in range(30):
            candidate = {"candidate": f"candidate:{i}", "sdpMid": "0"}
            ws_b.send_json({"type": "ice", "to": a["participant_id"], "candidate": candidate})
        ws_b.send_json({"type": "media-state", "audio": True, "video": True})

        got = [ws_a.receive_json() for _ in range(32)]
        assert [m["type"] for m in got] == ["offer"] + ["ice"] * 30 + ["media-state"]
        # and the sender was never told to slow down
        assert not [m for m in until_pong(ws_b) if m.get("code") == "rate_limited"]


def test_a_quiet_tab_stays_in_the_room_while_its_socket_is_open(settings, events):
    # a background tab (or a locked phone) barely pings; the open socket alone keeps it in.
    # Before: it dropped out of presence and a newcomer saw an empty room, nobody called anybody
    settings.presence_ttl_seconds = 1  # the presence store takes it when the app starts

    async def factory(s):
        return await build_container(s, events=events)

    with TestClient(create_app(settings, container_factory=factory)) as client:
        room = create_room(client)
        a, b = connect_pair(client, room)
        with client.websocket_connect(ws_url(a)) as ws_a:
            ws_a.receive_json()
            time.sleep(2.5)  # no pings from A, longer than the ttl
            with client.websocket_connect(ws_url(b)) as ws_b:
                welcome = ws_b.receive_json()
                assert [p["id"] for p in welcome["peers"]] == [a["participant_id"]]


# ---------- short drops ----------


def test_a_short_drop_is_not_a_leave(client, settings):
    # the socket dies (wifi blip, a frozen tab) and comes back within the grace period:
    # the other side never hears "peer-left", so its video keeps going
    settings.leave_grace_seconds = 2
    room = create_room(client)
    a, b = connect_pair(client, room)
    with client.websocket_connect(ws_url(a)) as ws_a:
        ws_a.receive_json()
        with client.websocket_connect(ws_url(b)) as ws_b:
            ws_b.receive_json(), ws_a.receive_json()
            ws_b.close(code=1006)  # abnormal: no close frame, like a dropped connection

        assert until_pong(ws_a) == []
        with client.websocket_connect(ws_url(b)) as ws_b2:
            welcome = ws_b2.receive_json()
            assert [p["id"] for p in welcome["peers"]] == [a["participant_id"]]
            assert welcome["rejoined"] is True  # so B keeps its connection too
            back = ws_a.receive_json()
            assert back["type"] == "peer-joined" and back["rejoined"] is True

            time.sleep(2.5)  # past the grace: still no leave
            assert until_pong(ws_a) == []


def test_reconnecting_before_the_server_noticed_the_drop_is_a_comeback(client, settings):
    # the client gave up on its socket first (and opened a new one) while ours still looks open
    room = create_room(client)
    a, b = connect_pair(client, room)
    with client.websocket_connect(ws_url(a)) as ws_a:
        ws_a.receive_json()
        with client.websocket_connect(ws_url(b)) as ws_b:
            ws_b.receive_json(), ws_a.receive_json()
            with client.websocket_connect(ws_url(b)) as ws_b2:
                assert ws_b2.receive_json()["rejoined"] is True
                back = ws_a.receive_json()
                assert back["type"] == "peer-joined" and back["rejoined"] is True
                # the old socket is closed as replaced, the others hear no leave
                assert until_pong(ws_a) == []


def test_a_drop_that_doesnt_come_back_leaves_after_the_grace(client, settings):
    settings.leave_grace_seconds = 1
    room = create_room(client)
    a, b = connect_pair(client, room)
    with client.websocket_connect(ws_url(a)) as ws_a:
        ws_a.receive_json()
        with client.websocket_connect(ws_url(b)) as ws_b:
            ws_b.receive_json(), ws_a.receive_json()
            ws_b.close(code=1006)

        assert until_pong(ws_a) == []  # not right away
        time.sleep(1.5)
        assert until_pong(ws_a) == [{"type": "peer-left", "peer_id": b["participant_id"]}]

        # too late to count as a comeback: B starts fresh, and is told so
        with client.websocket_connect(ws_url(b)) as ws_b2:
            assert "rejoined" not in ws_b2.receive_json()
            assert "rejoined" not in ws_a.receive_json()


def test_going_away_is_a_drop_too(client, settings):
    # Chrome closes a frozen background tab's socket with 1001: not a goodbye
    settings.leave_grace_seconds = 30
    room = create_room(client)
    a, b = connect_pair(client, room)
    with client.websocket_connect(ws_url(a)) as ws_a:
        ws_a.receive_json()
        with client.websocket_connect(ws_url(b)) as ws_b:
            ws_b.receive_json(), ws_a.receive_json()
            ws_b.close(code=1001)
        assert until_pong(ws_a) == []


def test_hanging_up_leaves_at_once(client, settings):
    settings.leave_grace_seconds = 30
    room = create_room(client)
    a, b = connect_pair(client, room)
    with client.websocket_connect(ws_url(a)) as ws_a:
        ws_a.receive_json()
        with client.websocket_connect(ws_url(b)) as ws_b:
            ws_b.receive_json(), ws_a.receive_json()
            ws_b.close(code=1000)  # the client said bye

        assert ws_a.receive_json() == {"type": "peer-left", "peer_id": b["participant_id"]}
