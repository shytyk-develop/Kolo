# src/kolo/services/signaling/hub.py

"""Links ws sessions together, in this process and across nodes.

Each message goes to the room channel as {"to", "exclude", "role", "data"},
every node passes it to its matching local sessions.
"""

import asyncio
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from kolo.core.logging import log
from kolo.infra.broker import Broker

if TYPE_CHECKING:
    from kolo.services.signaling.session import PeerSession


class SignalingHub:
    def __init__(self, broker: Broker) -> None:
        self._broker = broker
        # room -> {peer_id -> session}
        self._local: dict[str, dict[str, PeerSession]] = {}
        # room -> listener task
        self._listeners: dict[str, asyncio.Task] = {}
        # (room, peer) -> a leave waiting out the grace period (the socket dropped, not a bye)
        self._pending_leaves: dict[tuple[str, str], asyncio.Task] = {}
        self._lock = asyncio.Lock()

    @staticmethod
    def channel(room_code: str) -> str:
        return f"kolo:room:{room_code}"

    def local_count(self) -> int:
        return sum(len(sessions) for sessions in self._local.values())

    async def attach(self, session: "PeerSession") -> None:
        room = session.room_code
        
        async with self._lock:
            # back within the grace period: the leave never happens, it's the same person going on
            session.rejoined = self.cancel_leave(room, session.peer.id)
            sessions = self._local.setdefault(room, {})
            old = sessions.get(session.peer.id)
            sessions[session.peer.id] = session
            # same ticket while the old socket is still here: the client reconnected before we
            # noticed the old one die (network switch, its heartbeat gave up first). Also a comeback
            if old is not None:
                session.rejoined = True
            
            # second tab: kick the old one
            if old is not None: 
                old.deliver({"type": "_replaced"})
                
            # first peer of the room on this node -> subscribe
            if room not in self._listeners:
                ready = asyncio.Event()
                task = asyncio.create_task(self._listen(room, ready))
                self._listeners[room] = task
                
                waiter = asyncio.create_task(ready.wait())
                
                # wait for the subscribe or a crash
                done, _ = await asyncio.wait(
                    {waiter, task}, 
                    return_when=asyncio.FIRST_COMPLETED
                )
                
                if task in done:  # subscribe failed
                    waiter.cancel()
                    self._listeners.pop(room, None)
                    task.result()  # raise the real error

    async def detach(self, session: "PeerSession") -> None:
        room = session.room_code
        
        async with self._lock:
            sessions = self._local.get(room, {})
            
            # only if it's this exact session (second tab race)
            if sessions.get(session.peer.id) is session:
                del sessions[session.peer.id]
                
            # nobody left here -> stop listening
            if not sessions:
                self._local.pop(room, None)
                task = self._listeners.pop(room, None)
                if task:
                    task.cancel()

    def schedule_leave(
        self, room_code: str, peer_id: str, delay: float, finish: Callable[[], Awaitable[None]]
    ) -> None:
        """Run finish (presence out, "peer-left") after delay, unless the peer comes back first."""
        key = (room_code, peer_id)
        self.cancel_leave(room_code, peer_id)

        async def later() -> None:
            await asyncio.sleep(delay)
            self._pending_leaves.pop(key, None)
            try:
                await finish()
            except Exception:
                # broker down: presence ttl drops the peer later
                log.warning("peer_leave_failed", room=room_code, peer=peer_id)

        self._pending_leaves[key] = asyncio.create_task(later())

    def cancel_leave(self, room_code: str, peer_id: str) -> bool:
        task = self._pending_leaves.pop((room_code, peer_id), None)
        if task is None:
            return False
        task.cancel()
        return True

    async def publish(
        self, 
        room_code: str, 
        data: dict, 
        *,
        to: str | None = None, 
        exclude: str | None = None, 
        role: str | None = None,
    ) -> None:
        # wrap with routing info and publish
        envelope = {"to": to, "exclude": exclude, "role": role, "data": data}
        await self._broker.publish(self.channel(room_code), envelope)

    async def _listen(self, room: str, ready: asyncio.Event) -> None:
        try:
            async with self._broker.subscribe(self.channel(room)) as messages:
                ready.set()  # tell attach() we're subscribed
                
                # read the channel
                async for envelope in messages:
                    self._dispatch(room, envelope)
            log.warning("room_listener_ended", room=room)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("room_listener_crashed", room=room)
            # never subscribed: attach() re-raises this
            if not ready.is_set():
                raise

        self._on_listener_lost(room)

    def _on_listener_lost(self, room: str) -> None:
        """Lost the subscription: close local sessions so they reconnect."""
        # detach() may have stopped it on purpose
        if self._listeners.get(room) is not asyncio.current_task():
            return

        del self._listeners[room]
        for session in list(self._local.get(room, {}).values()):
            session.deliver({"type": "_listener_lost"})

    def _dispatch(self, room: str, envelope: dict) -> None:
        data = envelope["data"]
        is_control = data.get("type", "").startswith("_")
        
        for session in list(self._local.get(room, {}).values()):
            # routing filters
            if envelope["to"] and session.peer.id != envelope["to"]:
                continue
            if envelope["exclude"] == session.peer.id:
                continue
            if envelope["role"] and session.peer.role != envelope["role"]:
                continue
                
            # lobby guests get no room traffic, only control messages (_admitted etc)
            if not session.is_joined and not is_control:
                continue 
                
            session.deliver(data)