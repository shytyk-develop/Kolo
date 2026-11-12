# src/kolo/repositories/base.py

from datetime import datetime
from typing import Protocol

from kolo.domain.models import Room


class RoomRepository(Protocol):
    async def add(self, room: Room) -> None: ...
    
    async def get_by_code(self, code: str) -> Room | None: ...

    async def set_lobby(self, code: str, enabled: bool) -> Room | None: ...

    async def add_invite(self, code: str, invite_id: str) -> None: ...

    # removes and returns: each invite is ended once
    async def take_invites(self, code: str) -> list[str]: ...

    async def take_expired_invites(self, now: datetime) -> list[str]: ...