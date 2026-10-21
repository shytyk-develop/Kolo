# src/kolo/container.py

from dataclasses import dataclass
from kolo.core.config import Settings
from kolo.repositories.memory import InMemoryRoomRepository
from kolo.services.rooms import RoomService

@dataclass
class Container:
    settings: Settings
    rooms: RoomService

    async def aclose(self) -> None:
        pass

async def build_container(settings: Settings) -> Container:
    return Container(
        settings=settings,
        rooms=RoomService(InMemoryRoomRepository(), settings)
    )