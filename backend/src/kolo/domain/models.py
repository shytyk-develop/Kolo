# src/kolo/domain/models.py

"""Domain models, plain dataclasses."""
from dataclasses import asdict, dataclass
from datetime import datetime
from enum import StrEnum


class Role(StrEnum):
    HOST = "host"
    GUEST = "guest"

@dataclass(frozen=True, slots=True)
class Room:
    code: str
    name: str
    host_secret_hash: str
    max_participants: int
    lobby_enabled: bool
    created_at: datetime
    expires_at: datetime

    def is_expired(self, now: datetime) -> bool:
        return now >= self.expires_at

    def requires_admission(self, role: Role) -> bool:
        """Guests in a lobby room need the host's ok."""
        return self.lobby_enabled and role is Role.GUEST

@dataclass(frozen=True, slots=True)
class Peer:
    """Call participant, lives as long as its ws."""
    id: str
    name: str
    role: Role

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "Peer":
        return cls(id=data["id"], name=data["name"], role=Role(data["role"]))