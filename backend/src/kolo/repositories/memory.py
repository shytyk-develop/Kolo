# src/kolo/repositories/memory.py

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