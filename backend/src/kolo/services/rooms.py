# src/kolo/services/rooms.py

"""Room business logic, no HTTP."""
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from kolo.core.config import Settings
from kolo.core.security import create_room_token, hash_secret, new_participant_id, new_secret, verify_secret
from kolo.domain.errors import InvalidInput, RoomCodeTaken, RoomExpired, RoomFull, RoomNotFound
from kolo.domain.models import Role, Room
from kolo.domain.room_codes import generate_room_code, is_valid_room_code, normalize_room_code
from kolo.infra.presence import PresenceStore
from kolo.repositories.base import RoomRepository
from kolo.services.events import EventSink, NullEventSink
from kolo.services.turn import ice_servers_for


def utcnow() -> datetime:
    return datetime.now(UTC)

@dataclass(frozen=True)
class CreatedRoom:
    room: Room
    host_secret: str  # shown once, db keeps only the hash

@dataclass(frozen=True)
class JoinTicket:
    # everything a user needs to join
    room: Room
    participant_id: str
    role: Role
    token: str
    ice_servers: list[dict]

class RoomService:
    def __init__(
        self,
        repo: RoomRepository,
        settings: Settings,
        presence: PresenceStore,
        events: EventSink | None = None,
        clock=utcnow,
    ) -> None:
        self._repo = repo
        self._settings = settings
        self._presence = presence
        self._events = events or NullEventSink()
        self._clock = clock

    async def create_room(
        self, 
        name: str | None = None, 
        max_participants: int | None = None,
        lobby_enabled: bool = False
    ) -> CreatedRoom:
        limit = max_participants or self._settings.default_max_participants
        
        if not 2 <= limit <= self._settings.max_participants_limit:
            raise InvalidInput(
                f"max_participants must be between 2 and {self._settings.max_participants_limit}"
            )
            
        host_secret = new_secret()
        now = self._clock()
        
        for _ in range(5):  # collision is almost impossible, retry anyway
            code = generate_room_code()
            room = Room(
                code=code,
                name=(name or "").strip() or f"Room {code}",
                host_secret_hash=hash_secret(host_secret),
                max_participants=limit,
                lobby_enabled=lobby_enabled,
                created_at=now,
                expires_at=now + timedelta(hours=self._settings.room_ttl_hours),
            )
            
            try:
                await self._repo.add(room)
            except RoomCodeTaken:
                continue

            # no host_secret here, it never leaves kolo
            self._events.emit(
                "room.created",
                {
                    "code": room.code,
                    "name": room.name,
                    "max_participants": room.max_participants,
                    "lobby_enabled": room.lobby_enabled,
                    "expires_at": room.expires_at.isoformat(),
                },
            )
            return CreatedRoom(room=room, host_secret=host_secret)
            
        raise RuntimeError("Failed to generate a unique room code")

    async def get_room(self, raw_code: str) -> Room:
        code = normalize_room_code(raw_code)
        if not is_valid_room_code(code):
            raise RoomNotFound()
            
        room = await self._repo.get_by_code(code)
        if room is None:
            raise RoomNotFound()
            
        if room.is_expired(self._clock()):
            raise RoomExpired()
            
        return room

    async def participants_count(self, room: Room) -> int:
        return await self._presence.count(room.code)

    async def join(self, raw_code: str, display_name: str, host_secret: str | None) -> JoinTicket:
        room = await self.get_room(raw_code)

        # quick check, the real one is in PeerSession._join (two clients can race here)
        if await self.participants_count(room) >= room.max_participants:
            raise RoomFull()

        # guest unless the host secret matches
        role = Role.GUEST
        if host_secret and verify_secret(host_secret, room.host_secret_hash):
            role = Role.HOST
            
        participant_id = new_participant_id()
        
        # user info goes into the jwt
        token = create_room_token(
            self._settings, 
            room=room.code, 
            participant_id=participant_id,
            name=display_name, 
            role=role,
        )
        
        return JoinTicket(
            room=room, 
            participant_id=participant_id, 
            role=role, 
            token=token,
            # stun/turn for webrtc
            ice_servers=ice_servers_for(self._settings, participant_id),
        )