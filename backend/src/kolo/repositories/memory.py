# src/kolo/repositories/memory.py

from dataclasses import replace

from kolo.domain.errors import RoomCodeTaken
from kolo.domain.models import Room


class InMemoryRoomRepository:
    def __init__(self) -> None:
        self._rooms: dict[str, Room] = {}

    async def add(self, room: Room) -> None:
        if room.code in self._rooms:
            raise RoomCodeTaken()
        self._rooms[room.code] = room

    async def get_by_code(self, code: str) -> Room | None:
        return self._rooms.get(code)

    async def set_lobby(self, code: str, enabled: bool) -> Room | None:
        room = self._rooms.get(code)
        if room is None:
            return None
        self._rooms[code] = replace(room, lobby_enabled=enabled)
        return self._rooms[code]