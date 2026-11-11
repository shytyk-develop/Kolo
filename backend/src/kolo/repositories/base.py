# src/kolo/repositories/base.py

from typing import Protocol

from kolo.domain.models import Room


class RoomRepository(Protocol):
    async def add(self, room: Room) -> None: ...
    
    async def get_by_code(self, code: str) -> Room | None: ...

    async def set_lobby(self, code: str, enabled: bool) -> Room | None: ...