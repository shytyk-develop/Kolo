# src/kolo/services/signaling/hub.py

"""
Hub: connects WebSocket sessions in this process together and syncs them across nodes.
Every message goes into the room's pub/sub channel wrapped in an 'envelope':
{"to": id | None, "exclude": id | None, "role": "host" | None, "data": {...}}
Each node listens to the room channel and forwards the envelope to matching local sessions.
"""

import asyncio
from typing import TYPE_CHECKING

from kolo.core.logging import log
from kolo.infra.broker import Broker

if TYPE_CHECKING:
    from kolo.services.signaling.session import PeerSession


class SignalingHub:
    def __init__(self, broker: Broker) -> None:
        self._broker = broker
        # map: room_code -> {peer_id -> PeerSession}
        self._local: dict[str, dict[str, "PeerSession"]] = {}
        # map: room_code -> background listen task
        self._listeners: dict[str, asyncio.Task] = {}
        self._lock = asyncio.Lock()

    @staticmethod
    def channel(room_code: str) -> str:
        return f"kolo:room:{room_code}"

    def local_count(self) -> int:
        return sum(len(sessions) for sessions in self._local.values())

    async def attach(self, session: "PeerSession") -> None:
        room = session.room_code
        
        async with self._lock:
            sessions = self._local.setdefault(room, {})
            old = sessions.get(session.peer.id)
            sessions[session.peer.id] = session
            
            # if the user opened a second tab, boot the old connection
            if old is not None: 
                old.deliver({"type": "_replaced"})
                
            # if this is the first person in the room on this node, subscribe to the broker
            if room not in self._listeners:
                ready = asyncio.Event()
                task = asyncio.create_task(self._listen(room, ready))
                self._listeners[room] = task
                
                waiter = asyncio.create_task(ready.wait())
                
                # wait until the subscription is active OR the task crashes immediately
                done, _ = await asyncio.wait(
                    {waiter, task}, 
                    return_when=asyncio.FIRST_COMPLETED
                )
                
                if task in done:  # subscription failed before it even started
                    waiter.cancel()
                    self._listeners.pop(room, None)
                    task.result()  # raise the inner exception so we see the error

    async def detach(self, session: "PeerSession") -> None:
        room = session.room_code
        
        async with self._lock:
            sessions = self._local.get(room, {})
            
            # only delete if it's actually the exact session we're detaching
            # (protects against race conditions with second tabs)
            if sessions.get(session.peer.id) is session:
                del sessions[session.peer.id]
                
            # if everyone left, we don't need to listen to this room's channel anymore
            if not sessions:
                self._local.pop(room, None)
                task = self._listeners.pop(room, None)
                if task:
                    task.cancel()

    async def publish(
        self, 
        room_code: str, 
        data: dict, 
        *,
        to: str | None = None, 
        exclude: str | None = None, 
        role: str | None = None,
    ) -> None:
        # pack the payload with routing metadata and blast it out
        envelope = {"to": to, "exclude": exclude, "role": role, "data": data}
        await self._broker.publish(self.channel(room_code), envelope)

    async def _listen(self, room: str, ready: asyncio.Event) -> None:
        try:
            async with self._broker.subscribe(self.channel(room)) as messages:
                ready.set()  # signal to attach() that we are successfully hooked up
                
                # keep pulling messages from the channel
                async for envelope in messages:
                    self._dispatch(room, envelope)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("room_listener_crashed", room=room)
            raise

    def _dispatch(self, room: str, envelope: dict) -> None:
        data = envelope["data"]
        is_control = data.get("type", "").startswith("_")
        
        for session in list(self._local.get(room, {}).values()):
            # check all the routing filters
            if envelope["to"] and session.peer.id != envelope["to"]:
                continue
            if envelope["exclude"] == session.peer.id:
                continue
            if envelope["role"] and session.peer.role != envelope["role"]:
                continue
                
            # people stuck in the lobby shouldn't see room media/chat traffic, 
            # but they DO need system/control events (like being admitted or kicked)
            if not session.is_joined and not is_control:
                continue 
                
            session.deliver(data)