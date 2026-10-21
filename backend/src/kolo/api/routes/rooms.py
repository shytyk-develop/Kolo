# src/kolo/api/routes/rooms.py

from fastapi import APIRouter
from kolo.api.deps import ContainerDep
from kolo.schemas.rooms import CreateRoomRequest, RoomCreatedResponse, RoomPublicResponse

router = APIRouter(prefix="/rooms", tags=["rooms"])

@router.post("", status_code=201, response_model=RoomCreatedResponse)
async def create_room(body: CreateRoomRequest, c: ContainerDep) -> RoomCreatedResponse:
    created = await c.rooms.create_room(body.name, body.max_participants, body.lobby_enabled)
    room = created.room
    return RoomCreatedResponse(
        code=room.code,
        name=room.name,
        join_url=f"{c.settings.public_url}/r/{room.code}",
        host_secret=created.host_secret,
        max_participants=room.max_participants,
        lobby_enabled=room.lobby_enabled,
        expires_at=room.expires_at,
    )

@router.get("/{code}", response_model=RoomPublicResponse)
async def get_room(code: str, c: ContainerDep) -> RoomPublicResponse:
    room = await c.rooms.get_room(code)
    return RoomPublicResponse(
        code=room.code, 
        name=room.name,
        max_participants=room.max_participants,
        lobby_enabled=room.lobby_enabled,
    )