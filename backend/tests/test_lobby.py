# tests/test_lobby.py

"""Waiting room: guests see nothing and can do nothing until the host lets them in."""
import asyncio
import threading
from collections.abc import Iterator

import pytest
from fastapi import WebSocketDisconnect
from fastapi.testclient import TestClient

from kolo.container import build_container
from kolo.core.config import Settings
from kolo.domain.models import Peer
from kolo.infra.presence import MemoryPresence
from kolo.main import create_app
from kolo.services.signaling.session import CLOSE_CONFLICT, CLOSE_FORBIDDEN, CLOSE_OVERLOADED


class ControlledPresence(MemoryPresence):
    """Lets a test hold the admission halfway through, or make it fail."""

    def __init__(self) -> None:
        super().__init__()
        self.add_delay = 0.0
        self.fail_add = False
        self.add_started = threading.Event()

    async def add(self, room: str, peer: Peer) -> int:
        self.add_started.set()
        if self.fail_add:
            raise ConnectionError("presence store is down")
        if self.add_delay:
            await asyncio.sleep(self.add_delay)
        return await super().add(room, peer)


@pytest.fixture
def presence() -> ControlledPresence:
    return ControlledPresence()


@pytest.fixture
def client(settings: Settings, presence: ControlledPresence) -> Iterator[TestClient]:
    async def factory(app_settings: Settings):
        container = await build_container(app_settings)
        container.presence = presence  # sessions use this one, /join keeps its own empty store
        return container

    with TestClient(create_app(settings, container_factory=factory)) as test_client:
        yield test_client


def lobby_room(client: TestClient, max_participants: int = 4) -> dict:
    return client.post(
        "/api/v1/rooms", json={"lobby_enabled": True, "max_participants": max_participants}
    ).json()


def join(client: TestClient, room: dict, name: str, *, host: bool = False) -> dict:
    body = {"display_name": name, "host_secret": room["host_secret"] if host else None}
    response = client.post(f"/api/v1/rooms/{room['code']}/join", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def connect(client: TestClient, ticket: dict):
    return client.websocket_connect(f"{ticket['ws_path']}?token={ticket['token']}")


def peer_of(ticket: dict, name: str) -> dict:
    return {"id": ticket["participant_id"], "name": name, "role": ticket["role"]}


def assert_closed(ws, code: int) -> None:
    with pytest.raises(WebSocketDisconnect) as closed:
        ws.receive_json()
    assert closed.value.code == code


def receive_until_pong(ws) -> list[dict]:
    """Everything that arrived before this ping, so a test can also assert what did NOT arrive."""
    ws.send_json({"type": "ping"})
    messages = []
    while (message := ws.receive_json())["type"] != "pong":
        messages.append(message)
    return messages


def test_lobby_admit_flow(client: TestClient) -> None:
    room = lobby_room(client)
    host, guest = join(client, room, "Аня", host=True), join(client, room, "Боря")

    with connect(client, host) as ws_host:
        welcome = ws_host.receive_json()
        assert welcome["type"] == "welcome"
        assert welcome["lobby"] == []

        with connect(client, guest) as ws_guest:
            assert ws_guest.receive_json() == {"type": "lobby", "status": "waiting"}
            assert ws_host.receive_json() == {"type": "lobby-request", "peer": peer_of(guest, "Боря")}

            # The room's chat must not reach the waiting guest
            ws_host.send_json({"type": "chat", "text": "только для своих"})
            assert ws_host.receive_json()["text"] == "только для своих"

            # And the guest can't do anything in the room yet
            ws_guest.send_json({"type": "offer", "to": host["participant_id"], "sdp": "v=0"})
            assert ws_guest.receive_json()["code"] == "not_joined"
            ws_guest.send_json({"type": "chat", "text": "можно войти?"})
            assert ws_guest.receive_json()["code"] == "not_joined"

            ws_host.send_json({"type": "admit", "peer_id": guest["participant_id"]})

            # The order of these two is not guaranteed once they travel through Redis
            messages = [ws_host.receive_json(), ws_host.receive_json()]
            assert {"type": "lobby-left", "peer_id": guest["participant_id"]} in messages
            assert {"type": "peer-joined", "peer": peer_of(guest, "Боря")} in messages

            # The very next message is the welcome: nothing leaked while waiting
            welcome = ws_guest.receive_json()
            assert welcome["type"] == "welcome"
            assert welcome["peers"] == [peer_of(host, "Аня")]
            assert "lobby" not in welcome  # the waiting list is for hosts only

            # Now the guest is a full participant
            ws_guest.send_json({"type": "offer", "to": host["participant_id"], "sdp": "v=0"})
            assert ws_host.receive_json() == {
                "type": "offer",
                "from": guest["participant_id"],
                "sdp": "v=0",
            }


def test_lobby_deny(client: TestClient) -> None:
    room = lobby_room(client)
    host, guest = join(client, room, "Аня", host=True), join(client, room, "Боря")

    with connect(client, host) as ws_host:
        ws_host.receive_json()

        with connect(client, guest) as ws_guest:
            ws_guest.receive_json()
            ws_host.receive_json()

            ws_host.send_json({"type": "deny", "peer_id": guest["participant_id"]})

            assert ws_guest.receive_json() == {"type": "denied"}
            assert_closed(ws_guest, CLOSE_FORBIDDEN)
            assert ws_host.receive_json() == {"type": "lobby-left", "peer_id": guest["participant_id"]}

        # A second host device doesn't see the denied guest in the waiting list
        with connect(client, join(client, room, "Аня-2", host=True)) as ws_other_host:
            assert ws_other_host.receive_json()["lobby"] == []


def test_guests_cannot_admit(client: TestClient) -> None:
    room = lobby_room(client)
    host, friend, stranger = (
        join(client, room, "Аня", host=True),
        join(client, room, "Боря"),
        join(client, room, "Незнакомец"),
    )

    with connect(client, host) as ws_host, connect(client, friend) as ws_friend:
        ws_host.receive_json()
        ws_friend.receive_json()
        ws_host.receive_json()
        ws_host.send_json({"type": "admit", "peer_id": friend["participant_id"]})
        assert ws_friend.receive_json()["type"] == "welcome"

        with connect(client, stranger) as ws_stranger:
            assert ws_stranger.receive_json()["type"] == "lobby"

            # A waiting guest can't let themselves in
            ws_stranger.send_json({"type": "admit", "peer_id": stranger["participant_id"]})
            assert ws_stranger.receive_json()["code"] == "not_joined"

            # A joined guest can't let anyone in
            ws_friend.send_json({"type": "admit", "peer_id": stranger["participant_id"]})
            assert ws_friend.receive_json()["code"] == "forbidden"

            ws_stranger.send_json({"type": "ping"})
            assert ws_stranger.receive_json()["type"] == "pong"


def test_admitted_guest_skips_lobby_after_reconnect(client: TestClient) -> None:
    room = lobby_room(client)
    host, guest = join(client, room, "Аня", host=True), join(client, room, "Боря")

    with connect(client, host) as ws_host:
        ws_host.receive_json()

        with connect(client, guest) as ws_guest:
            ws_guest.receive_json()
            ws_host.send_json({"type": "admit", "peer_id": guest["participant_id"]})
            assert ws_guest.receive_json()["type"] == "welcome"

        with connect(client, guest) as ws_guest:
            assert ws_guest.receive_json()["type"] == "welcome"


def test_host_who_comes_later_sees_waiting_guests(client: TestClient) -> None:
    room = lobby_room(client)
    host, guest = join(client, room, "Аня", host=True), join(client, room, "Боря")

    with connect(client, guest) as ws_guest:
        ws_guest.receive_json()

        with connect(client, host) as ws_host:
            welcome = ws_host.receive_json()
            assert welcome["peers"] == []  # the waiting guest is not in the room yet
            assert welcome["lobby"] == [peer_of(guest, "Боря")]


def test_guest_leaving_the_lobby_notifies_host(client: TestClient) -> None:
    room = lobby_room(client)
    host, guest = join(client, room, "Аня", host=True), join(client, room, "Боря")

    with connect(client, host) as ws_host:
        ws_host.receive_json()

        with connect(client, guest) as ws_guest:
            ws_guest.receive_json()
            assert ws_host.receive_json()["type"] == "lobby-request"

        assert ws_host.receive_json() == {"type": "lobby-left", "peer_id": guest["participant_id"]}


def test_double_admit_joins_once(client: TestClient, presence: ControlledPresence) -> None:
    room = lobby_room(client)
    host, guest = join(client, room, "Аня", host=True), join(client, room, "Боря")

    with connect(client, host) as ws_host, connect(client, guest) as ws_guest:
        ws_host.receive_json()
        ws_guest.receive_json()

        # Keep the first admission in progress while the second one arrives
        presence.add_delay = 0.1
        ws_host.send_json({"type": "admit", "peer_id": guest["participant_id"]})
        ws_host.send_json({"type": "admit", "peer_id": guest["participant_id"]})

        assert ws_guest.receive_json()["type"] == "welcome"
        assert receive_until_pong(ws_guest) == []

        assert ws_host.receive_json()["type"] == "lobby-request"
        seen = [ws_host.receive_json()["type"] for _ in range(3)] + [
            message["type"] for message in receive_until_pong(ws_host)
        ]
        assert seen.count("peer-joined") == 1


def test_leaving_during_admission_leaves_no_ghost(
    client: TestClient, presence: ControlledPresence
) -> None:
    room = lobby_room(client)
    host, guest = join(client, room, "Аня", host=True), join(client, room, "Боря")

    with connect(client, host) as ws_host:
        ws_host.receive_json()

        with connect(client, guest) as ws_guest:
            ws_guest.receive_json()
            ws_host.receive_json()

            presence.add_delay = 0.1
            presence.add_started.clear()
            ws_host.send_json({"type": "admit", "peer_id": guest["participant_id"]})
            assert presence.add_started.wait(timeout=5)
            ws_guest.close()

        client.portal.call(asyncio.sleep, 0.2)  # let the admission finish
        assert client.portal.call(presence.count, room["code"]) == 1  # only the host


def test_admission_failure_closes_instead_of_hanging(
    client: TestClient, presence: ControlledPresence
) -> None:
    room = lobby_room(client)
    host, guest = join(client, room, "Аня", host=True), join(client, room, "Боря")

    with connect(client, host) as ws_host, connect(client, guest) as ws_guest:
        ws_host.receive_json()
        ws_guest.receive_json()

        presence.fail_add = True
        ws_host.send_json({"type": "admit", "peer_id": guest["participant_id"]})

        assert_closed(ws_guest, CLOSE_OVERLOADED)


def test_admitting_into_a_full_room_is_rejected(client: TestClient) -> None:
    room = lobby_room(client, max_participants=2)
    host, first, second = (
        join(client, room, "Аня", host=True),
        join(client, room, "Боря"),
        join(client, room, "Вера"),
    )

    with connect(client, host) as ws_host, connect(client, first) as ws_first:
        ws_host.receive_json()
        ws_first.receive_json()

        with connect(client, second) as ws_second:
            ws_second.receive_json()

            ws_host.send_json({"type": "admit", "peer_id": first["participant_id"]})
            assert ws_first.receive_json()["type"] == "welcome"

            ws_host.send_json({"type": "admit", "peer_id": second["participant_id"]})
            assert ws_second.receive_json()["code"] == "room_full"
            assert_closed(ws_second, CLOSE_CONFLICT)
