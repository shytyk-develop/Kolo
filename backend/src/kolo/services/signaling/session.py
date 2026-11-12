"""One participant's ws session, from connect to disconnect."""

import asyncio
import time

from fastapi import WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from kolo.core.config import Settings
from kolo.core.logging import log
from kolo.domain.models import Peer, Role, Room
from kolo.infra.presence import PresenceStore
from kolo.infra.rate_limit import TokenBucket
from kolo.schemas.signaling import (
    AdmitMessage,
    AnswerMessage,
    ChatMessage,
    DenyMessage,
    IceMessage,
    MediaStateMessage,
    OfferMessage,
    PingMessage,
    client_message_adapter,
)
from kolo.services import metrics
from kolo.services.events import EventSink
from kolo.services.sfu import sfu_token, uses_sfu
from kolo.services.signaling.hub import SignalingHub
from kolo.services.telegram import TelegramService

# app close codes (4000-4999)
CLOSE_UNAUTHORIZED = 4401
CLOSE_FORBIDDEN = 4403
CLOSE_NOT_FOUND = 4404
CLOSE_CONFLICT = 4409
CLOSE_GONE = 4410
CLOSE_POLICY = 1008
CLOSE_OVERLOADED = 1013

REASON_UNAVAILABLE = "signaling_unavailable"

MAX_VIOLATIONS = 50

# closes that mean "I'm leaving": the client's bye (1000, also sent when the tab really
# closes) or the server said no for good (4xxx). Anything else is a drop: wait for a comeback.
# 1001 "going away" too: Chrome sends it when it freezes a background tab, not only on close
def _is_a_real_leave(code: int | None) -> bool:
    return code == 1000 or (code is not None and 4000 <= code < 5000)

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
        telegram: TelegramService | None = None,
    ) -> None:
        self.ws = ws
        self.room = room
        self.peer = peer
        self.room_code = room.code
        
        self.state = "connecting"  # flow: connecting -> [lobby ->] joined -> closed
        
        self._hub = hub
        self._presence = presence
        self._settings = settings
        self._events = events
        self._telegram = telegram
        
        self._outbox: asyncio.Queue[dict] = asyncio.Queue(maxsize=256)
        self._bucket = TokenBucket(settings.ws_burst, settings.ws_messages_per_second)
        self._violations = 0
        self._replaced = False
        self._admitting = False
        self._tasks: set[asyncio.Task] = set()
        # set by the hub on attach: this peer dropped a moment ago and is back (grace period)
        self.rejoined = False
        # how the socket ended, for the leave decision and the logs
        self._close_code: int | None = None
        self._close_reason = ""
        self._closed_by = ""

    @property
    def is_joined(self) -> bool:
        return self.state == "joined"

    # ---------- outgoing ----------
    
    def send(self, data: dict) -> None:
        try:
            self._outbox.put_nowait(data)
        except asyncio.QueueFull: 
            # client reads too slow, drop it
            self._spawn(self._close_ws(CLOSE_OVERLOADED, "slow_consumer"))

    def deliver(self, data: dict) -> None:
        """Hub calls this when a message comes for us."""
        kind = data.get("type")
        if kind == "_admitted" and self.state == "lobby" and not self._admitting:
            # double admit click: state is still lobby until _join() ends
            self._admitting = True
            self._spawn(self._join_safely())
        elif kind == "_denied" and self.state == "lobby":
            self.send({"type": "denied"})
            self._spawn(self._close_ws(CLOSE_FORBIDDEN, "denied"))
        elif kind == "_replaced":
            self._replaced = True
            self._spawn(self._close_ws(CLOSE_CONFLICT, "replaced"))
        elif kind == "_listener_lost":
            self._spawn(self._close_ws(CLOSE_OVERLOADED, REASON_UNAVAILABLE))
        elif not kind.startswith("_"):
            self.send(data)

    def error(self, code: str, message: str) -> None:
        self.send({"type": "error", "code": code, "message": message})

    async def _writer(self) -> None:
        # writes queued messages to the socket
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
        self._close_code, self._close_reason, self._closed_by = code, reason, "server"
            
        try: 
            # let the last messages (like the error) go out first
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
        keepalive = asyncio.create_task(self._keepalive())
        metrics.WS_CONNECTIONS.inc()
        
        try:
            await self._hub.attach(self)
            log.info("peer_connected", room=self.room_code, peer=self.peer.id, role=self.peer.role)
            
            # admitted guests skip the lobby on reconnect
            needs_lobby = self.room.requires_admission(self.peer.role)
            if needs_lobby and not await self._presence.is_admitted(self.room_code, self.peer.id):
                await self._enter_lobby()
            else:
                await self._join()
                
            await self._read_loop()
        except WebSocketDisconnect as exc:
            if not self._closed_by:
                self._close_code, self._close_reason, self._closed_by = exc.code, exc.reason or "", "client"
        except SessionClosed as exc:
            await self._close_ws(exc.code, exc.reason)
        except Exception:
            # usually broker/presence is down, client should retry
            log.exception("peer_session_failed", room=self.room_code, peer=self.peer.id)
            await self._close_ws(CLOSE_OVERLOADED, REASON_UNAVAILABLE)
        finally:
            metrics.WS_CONNECTIONS.dec()
            await self._leave()
            await self._hub.detach(self)
            writer.cancel()
            keepalive.cancel()
            log.info(
                "peer_disconnected",
                room=self.room_code,
                peer=self.peer.id,
                code=self._close_code,
                reason=self._close_reason,
                by=self._closed_by or "unknown",
            )

    async def _keepalive(self) -> None:
        """While the socket is open, this peer is here: keep its presence fresh ourselves.

        Client pings can't be trusted for that: a background tab sends them once a minute,
        a locked phone not at all. Without this the peer fell out of presence while its socket
        was fine, and a newcomer saw an empty room. Presence ttl is left for dead servers.
        """
        every = max(0.2, self._settings.presence_ttl_seconds / 3)
        while True:
            await asyncio.sleep(every)
            if not self.is_joined:
                continue
            try:
                await self._presence.touch(self.room_code, self.peer.id)
            except Exception:
                log.warning("presence_touch_failed", room=self.room_code, peer=self.peer.id)

    async def _enter_lobby(self) -> None:
        self.state = "lobby"
        await self._presence.add_waiting(self.room_code, self.peer)
        self.send({"type": "lobby", "status": "waiting"})
        await self._hub.publish(
            self.room_code, 
            {"type": "lobby-request", "peer": self.peer.to_dict()}, 
            role=Role.HOST
        )

    async def _join_safely(self) -> None:
        """Runs as its own task after admit, so catch errors here."""
        try:
            await self._join()
        except SessionClosed as exc:
            await self._close_ws(exc.code, exc.reason)
        except Exception:
            log.exception("peer_admission_failed", room=self.room_code, peer=self.peer.id)
            await self._close_ws(CLOSE_OVERLOADED, REASON_UNAVAILABLE)

    async def _join(self) -> None:
        count = await self._presence.add(self.room_code, self.peer)
        if count > self.room.max_participants:
            await self._presence.remove(self.room_code, self.peer.id)
            metrics.JOINS_REJECTED.labels("room_full").inc()
            self.error("room_full", "Room is full")
            raise SessionClosed(CLOSE_CONFLICT, "room_full")
            
        if self.state == "lobby":
            await self._presence.remove_waiting(self.room_code, self.peer.id)
            
        if self.state == "closed":
            # client left while we were adding it: don't leave a ghost
            # if replaced, the new session owns this peer id
            if not self._replaced:
                await self._presence.remove(self.room_code, self.peer.id)
            return
            
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
        if self.rejoined:
            # back within the grace period: the others kept their connections to us, keep ours.
            # Without it the others dropped us already and everything starts fresh
            welcome["rejoined"] = True
        if self.peer.role is Role.HOST and self.room.lobby_enabled:
            welcome["lobby"] = [p.to_dict() for p in await self._presence.list_waiting(self.room_code)]
        if uses_sfu(self._settings, self.room) and self.room.requires_admission(self.peer.role):
            # /join didn't give this token, give it now
            welcome["sfu_token"] = sfu_token(
                self._settings, self.room, self.peer.id, self.peer.name, self.peer.role
            )
            
        self.send(welcome)
        
        # rejoined: the same person after a drop, the others keep their working connection
        joined = {"type": "peer-joined", "peer": self.peer.to_dict()}
        if self.rejoined:
            joined["rejoined"] = True
        await self._hub.publish(self.room_code, joined, exclude=self.peer.id)
        if not self.rejoined:
            self._events.emit(
                "participant.joined",
                # no client_id: it's for the people in the call, not for integrations
                {"room": self.room_code, "id": self.peer.id, "name": self.peer.name, "role": self.peer.role}
            )

    async def _leave(self) -> None:
        state, self.state = self.state, "closed"
        
        if self._replaced: 
            # replaced by a new tab, no 'left' event
            return
            
        if state == "joined":
            grace = self._settings.leave_grace_seconds
            if grace > 0 and not _is_a_real_leave(self._close_code):
                # a drop, not a goodbye: give it a moment to come back
                log.info("peer_leave_deferred", room=self.room_code, peer=self.peer.id, seconds=grace)
                # a little slack: a keepalive already on its way to redis isn't a comeback
                left_at = time.time() + 0.5
                self._hub.schedule_leave(
                    self.room_code, self.peer.id, grace, lambda: self._finish_leave(deferred_from=left_at)
                )
                return
            await self._finish_leave()
        elif state == "lobby":
            try:
                await self._presence.remove_waiting(self.room_code, self.peer.id)
                await self._hub.publish(
                    self.room_code, 
                    {"type": "lobby-left", "peer_id": self.peer.id}, 
                    role=Role.HOST
                )
            except Exception:
                log.warning("peer_leave_failed", room=self.room_code, peer=self.peer.id)

    async def _finish_leave(self, *, deferred_from: float | None = None) -> None:
        if deferred_from is not None:
            # came back through another node meanwhile (this node cancels the leave itself):
            # its join refreshed presence after the drop
            seen = await self._presence.last_seen(self.room_code, self.peer.id)
            if seen is not None and seen > deferred_from:
                return
        # best effort: broker down must not stop the cleanup.
        # if it fails, presence ttl drops the peer later
        try:
            await self._presence.remove(self.room_code, self.peer.id)
            await self._hub.publish(
                self.room_code,
                {"type": "peer-left", "peer_id": self.peer.id},
                exclude=self.peer.id
            )
            # left while others stayed: that call is over
            if self._telegram is not None:
                others = await self._presence.members(self.room_code)
                if others:
                    self._telegram.call_ended(self.room_code, self.peer, others)
        except Exception:
            log.warning("peer_leave_failed", room=self.room_code, peer=self.peer.id)

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
                
            # lobby guests can only ping
            case _ if not self.is_joined:
                self.error("not_joined", "Wait for the host to let you in")
                
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
                
            case AdmitMessage() | DenyMessage():
                if self.peer.role is not Role.HOST:
                    self.error("forbidden", "Only the host can admit participants")
                    return
                    
                await self._presence.remove_waiting(self.room_code, msg.peer_id)
                if isinstance(msg, AdmitMessage):
                    await self._presence.admit(self.room_code, msg.peer_id)
                    control = "_admitted"
                else:
                    control = "_denied"
                    
                await self._hub.publish(self.room_code, {"type": control}, to=msg.peer_id)
                await self._hub.publish(
                    self.room_code, 
                    {"type": "lobby-left", "peer_id": msg.peer_id}, 
                    role=Role.HOST
                )
