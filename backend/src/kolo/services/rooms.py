# src/kolo/services/rooms.py

"""Business logic for rooms. No HTTP. Just the rules."""
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from kolo.core.config import Settings
from kolo.core.security import hash_secret, new_secret
from kolo.domain.errors import InvalidInput, RoomCodeTaken, RoomExpired, RoomNotFound
from kolo.domain.models import Room
from kolo.domain.room_codes import generate_room_code, is_valid_room_code, normalize_room_code
from kolo.repositories.base import RoomRepository

def utcnow() -> datetime:
    return datetime.now(UTC)

@dataclass(frozen=True)
class CreatedRoom:
    room: Room
    host_secret: str  # shown only once, database stores only the hash

class RoomService:
    def __init__(self, repo: RoomRepository, settings: Settings, clock=utcnow) -> None:
        self._repo = repo
        self._settings = settings
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
        
        for _ in range(5):  # code collision is almost impossible, but we handle it
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