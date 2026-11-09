from typing import Annotated

from fastapi import APIRouter, Header, Request

from kolo.api.deps import ContainerDep, client_ip
from kolo.core.security import check_api_key
from kolo.domain.errors import RateLimited, Unauthorized
from kolo.schemas.rooms import (
    CreateRoomRequest,
    JoinRequest,
    JoinResponse,
    RoomCreatedResponse,
    RoomPublicResponse,
)
from kolo.services.sfu import sfu_token, uses_sfu

router = APIRouter(tags=["rooms"])

@router.post("", status_code=201, response_model=RoomCreatedResponse)
async def create_room(
    body: CreateRoomRequest,
    request: Request,
    c: ContainerDep,
    x_api_key: Annotated[str | None, Header()] = None,
) -> RoomCreatedResponse:
    # check api key
    trusted = check_api_key(c.settings, x_api_key)
    
    if c.settings.require_api_key and not trusted:
        raise Unauthorized("X-API-Key header required")
        
    # not a trusted service -> take a token from the ip limiter
    if not trusted and not c.room_limiter.allow(client_ip(request)):
        raise RateLimited()
        
    created = await c.rooms.create_room(body.name, body.max_participants, body.lobby_enabled)
    
    return RoomCreatedResponse(
        code=created.room.code,
        name=created.room.name,
        join_url=f"{c.settings.frontend_url}/r/{created.room.code}",
        host_secret=created.host_secret,  # shown only here, once
        max_participants=created.room.max_participants,
        lobby_enabled=created.room.lobby_enabled,
        expires_at=created.room.expires_at,
    )

# public info, the page shows it before joining
@router.get("/{code}", response_model=RoomPublicResponse)
async def get_room(code: str, c: ContainerDep) -> RoomPublicResponse:
    room = await c.rooms.get_room(code)
    return RoomPublicResponse(
        code=room.code,
        name=room.name,
        max_participants=room.max_participants,
        lobby_enabled=room.lobby_enabled,
        participants=await c.rooms.participants_count(room),
    )


@router.post("/{code}/join", response_model=JoinResponse, response_model_exclude_none=True)
async def join_room(code: str, body: JoinRequest, c: ContainerDep) -> JoinResponse:
    ticket = await c.rooms.join(code, body.display_name, body.host_secret)

    media: dict = {}
    if uses_sfu(c.settings, ticket.room):
        media = {"media_mode": "sfu", "sfu_url": c.settings.livekit_url}
        # livekit doesn't know about the lobby, so lobby guests get the token in welcome after admit
        if not ticket.room.requires_admission(ticket.role):
            media["sfu_token"] = sfu_token(
                c.settings, ticket.room, ticket.participant_id, body.display_name, ticket.role
            )

    return JoinResponse(
        token=ticket.token,
        participant_id=ticket.participant_id,
        role=ticket.role,
        ws_path=f"/ws/rooms/{ticket.room.code}",
        expires_in=c.settings.jwt_ttl_seconds,
        ice_servers=ticket.ice_servers,
        **media,
    )