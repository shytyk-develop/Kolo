"""A single WebSocket session for one participant: from connection to disconnect."""

import asyncio
import time

from fastapi import WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from kolo.core.config import Settings
from kolo.core.logging import log
from kolo.domain.models import Peer, Room
from kolo.infra.presence import PresenceStore
from kolo.infra.rate_limit import TokenBucket
from kolo.schemas.signaling import (
    AnswerMessage,
    ChatMessage,
    IceMessage,
    MediaStateMessage,
    OfferMessage,
    PingMessage,
    client_message_adapter,
)
from kolo.services import metrics
from kolo.services.events import EventSink
from kolo.services.signaling.hub import SignalingHub

# Custom closure codes (4000-4999 are for apps per RFC 6455)
CLOSE_UNAUTHORIZED = 4401
CLOSE_FORBIDDEN = 4403
CLOSE_NOT_FOUND = 4404
CLOSE_CONFLICT = 4409
CLOSE_GONE = 4410
CLOSE_POLICY = 1008
CLOSE_OVERLOADED = 1013

MAX_VIOLATIONS = 50

class SessionClosed(Exception):
    def __init__(self, code: int, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason

class PeerSession:
    def __init__(
        self, 
        ws: WebSocket, 
        room: Room, 
        peer: Peer, 
        *,
        hub: SignalingHub, 
        presence: PresenceStore, 
        settings: Settings,
        events: EventSink,
    ) -> None:
        self.ws = ws
        self.room = room
        self.peer = peer
        self.room_code = room.code
        
        self.state = "connecting"  # flow: connecting -> joined -> closed
        
        self._hub = hub
        self._presence = presence
        self._settings = settings
        self._events = events
        
        self._outbox: asyncio.Queue[dict] = asyncio.Queue(maxsize=256)
        self._bucket = TokenBucket(settings.ws_burst, settings.ws_messages_per_second)
        self._violations = 0
        self._replaced = False
        self._tasks: set[asyncio.Task] = set()

    @property
    def is_joined(self) -> bool:
        return self.state == "joined"

    # ---------- outgoing ----------
    
    def send(self, data: dict) -> None:
        try:
            self._outbox.put_nowait(data)
        except asyncio.QueueFull: 
            # client is reading too slow (or connection stalled), kill it to free memory
            self._spawn(self._close_ws(CLOSE_OVERLOADED, "slow_consumer"))

    def deliver(self, data: dict) -> None:
        """Called by the Hub when a message arrives for us."""
        kind = data.get("type")
        if kind == "_replaced":
            self._replaced = True
            self._spawn(self._close_ws(CLOSE_CONFLICT, "replaced"))
        elif not kind.startswith("_"):
            self.send(data)

    def error(self, code: str, message: str) -> None:
        self.send({"type": "error", "code": code, "message": message})

    async def _writer(self) -> None:
        # background worker just pulling from the queue and writing to the socket
        while True:
            data = await self._outbox.get()
            try:
                await self.ws.send_json(data)
            except Exception:
                return
            finally:
                self._outbox.task_done()

    async def _close_ws(self, code: int, reason: str) -> None:
        if self.state == "closed":
            return
            
        try: 
            # let the last messages (like the error itself) go out before snapping the wire
            await asyncio.wait_for(self._outbox.join(), timeout=1.0)
        except TimeoutError:
            pass
            
        await self._leave()
        try:
            await self.ws.close(code=code, reason=reason)
        except Exception:
            pass

    def _spawn(self, coro) -> None:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    # ---------- lifecycle ----------
    
    async def run(self) -> None:
        writer = asyncio.create_task(self._writer())
        await self._hub.attach(self)
        
        metrics.WS_CONNECTIONS.inc()
        log.info("peer_connected", room=self.room_code, peer=self.peer.id, role=self.peer.role)
        
        try:
            await self._join()
            await self._read_loop()
        except WebSocketDisconnect:
            pass
        except SessionClosed as exc:
            await self._close_ws(exc.code, exc.reason)
        finally:
            metrics.WS_CONNECTIONS.dec()
            await self._leave()
            await self._hub.detach(self)
            writer.cancel()
            log.info("peer_disconnected", room=self.room_code, peer=self.peer.id)

    async def _join(self) -> None:
        count = await self._presence.add(self.room_code, self.peer)
        if count > self.room.max_participants:
            await self._presence.remove(self.room_code, self.peer.id)
            metrics.JOINS_REJECTED.labels("room_full").inc()
            self.error("room_full", "Room is full")
            raise SessionClosed(CLOSE_CONFLICT, "room_full")
            
        self.state = "joined"
        
        peers = [
            p.to_dict() for p in await self._presence.members(self.room_code)
            if p.id != self.peer.id
        ]
        
        welcome = {
            "type": "welcome",
            "you": self.peer.to_dict(),
            "room": {
                "code": self.room.code, 
                "name": self.room.name,
                "max_participants": self.room.max_participants,
                "lobby_enabled": self.room.lobby_enabled
            },
            "peers": peers,
        }
        self.send(welcome)
        
        await self._hub.publish(
            self.room_code, 
            {"type": "peer-joined", "peer": self.peer.to_dict()}, 
            exclude=self.peer.id
        )
        self._events.emit(
            "participant.joined", 
            {"room": self.room_code, **self.peer.to_dict()}
        )

    async def _leave(self) -> None:
        state, self.state = self.state, "closed"
        
        if self._replaced: 
            # new tab opened by the same user took over, don't emit 'left' event
            return
            
        if state == "joined":
            await self._presence.remove(self.room_code, self.peer.id)
            await self._hub.publish(
                self.room_code, 
                {"type": "peer-left", "peer_id": self.peer.id}, 
                exclude=self.peer.id
            )
            self._events.emit("participant.left", {"room": self.room_code, "id": self.peer.id})

    # ---------- incoming ----------
    
    async def _read_loop(self) -> None:
        while True:
            message = await self.ws.receive()
            if message["type"] == "websocket.disconnect":
                raise WebSocketDisconnect(message.get("code", 1000))
                
            if self.state == "closed":
                return
                
            raw = message.get("text")
            if raw is None:
                self.error("bad_message", "Expected text JSON")
                continue
                
            if len(raw.encode()) > self._settings.ws_max_message_bytes:
                self.error("too_large", "Message too large")
                continue
                
            if not self._bucket.allow():
                self._violations += 1
                if self._violations >= MAX_VIOLATIONS:
                    raise SessionClosed(CLOSE_POLICY, "rate_limited")
                self.error("rate_limited", "Too many messages")
                continue
                
            try:
                msg = client_message_adapter.validate_json(raw)
            except ValidationError as exc:
                self.error("bad_message", exc.errors(include_url=False)[0]["msg"])
                continue
                
            metrics.SIGNALING_MESSAGES.labels(msg.type).inc()
            await self._handle(msg)

    async def _handle(self, msg) -> None:
        me = self.peer.id
        
        match msg:
            case PingMessage():
                await self._presence.touch(self.room_code, me)
                self.send({"type": "pong", "ts": int(time.time() * 1000)})
                
            case OfferMessage() | AnswerMessage():
                await self._hub.publish(
                    self.room_code, 
                    {"type": msg.type, "from": me, "sdp": msg.sdp}, 
                    to=msg.to
                )
                
            case IceMessage():
                await self._hub.publish(
                    self.room_code, 
                    {"type": "ice", "from": me, "candidate": msg.candidate}, 
                    to=msg.to
                )
                
            case ChatMessage():
                await self._hub.publish(
                    self.room_code, 
                    {
                        "type": "chat", 
                        "from": me, 
                        "name": self.peer.name,
                        "text": msg.text, 
                        "ts": int(time.time() * 1000),
                    }
                )
                
            case MediaStateMessage():
                await self._hub.publish(
                    self.room_code,
                    {
                        "type": "media-state", 
                        "from": me, 
                        "audio": msg.audio,
                        "video": msg.video
                    },
                    exclude=me,
                )