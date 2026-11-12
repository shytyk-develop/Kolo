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
    # the person's browser, stable across calls (id is per call): lets clients recognize each other
    client_id: str | None = None
    # Kolo ID from the server-checked Telegram cookie, never from the client
    handle: str | None = None

    def to_dict(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v is not None or k not in ("client_id", "handle")}

    @classmethod
    def from_dict(cls, data: dict) -> "Peer":
        return cls(
            id=data["id"],
            name=data["name"],
            role=Role(data["role"]),
            client_id=data.get("client_id"),
            handle=data.get("handle"),
        )