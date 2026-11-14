from typing import Annotated

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse

from kolo.api.deps import ContainerDep, client_ip, limit_lookups
from kolo.api.errors import kolo_error_handler
from kolo.api.routes.me import forget, linked_of, telegram_of
from kolo.core.security import check_api_key, decode_room_token
from kolo.domain.errors import RateLimited, TelegramNotLinked, Unauthorized
from kolo.schemas.rooms import (
    CreateRoomRequest,
    IceResponse,
    InviteRequest,
    InviteResponse,
    JoinRequest,
    JoinResponse,
    RoomCreatedResponse,
    RoomPublicResponse,
    UpdateRoomRequest,
)
from kolo.services.sfu import sfu_token, uses_sfu
from kolo.services.turn import ice_servers_for

router = APIRouter(tags=["rooms"])

Lookup = Depends(limit_lookups)

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
@router.get("/{code}", response_model=RoomPublicResponse, dependencies=[Lookup])
async def get_room(code: str, c: ContainerDep) -> RoomPublicResponse:
    room = await c.rooms.get_room(code)
    return RoomPublicResponse(
        code=room.code,
        name=room.name,
        max_participants=room.max_participants,
        lobby_enabled=room.lobby_enabled,
        participants=await c.rooms.participants_count(room),
    )


# host only: turn the waiting room on or off after the room is made
@router.patch("/{code}", response_model=RoomPublicResponse, dependencies=[Lookup])
async def update_room(code: str, body: UpdateRoomRequest, c: ContainerDep) -> RoomPublicResponse:
    room = await c.rooms.set_lobby(code, body.host_secret, body.lobby_enabled)
    return RoomPublicResponse(
        code=room.code,
        name=room.name,
        max_participants=room.max_participants,
        lobby_enabled=room.lobby_enabled,
        participants=await c.rooms.participants_count(room),
    )


@router.post(
    "/{code}/join", response_model=JoinResponse, response_model_exclude_none=True, dependencies=[Lookup]
)
async def join_room(code: str, body: JoinRequest, request: Request, c: ContainerDep) -> JoinResponse:
    # the Kolo ID only ever comes from our own signed cookie
    linked = linked_of(request, c)
    ticket = await c.rooms.join(
        code, body.display_name, body.host_secret, body.client_id, linked.handle if linked else None, body.kid
    )

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
        ice_expires_in=c.settings.turn_ttl_seconds,
        **media,
    )

# fresh STUN/TURN logins mid-call (the old ones expire after minutes)
@router.post("/{code}/ice", response_model=IceResponse, dependencies=[Lookup])
async def fresh_ice(
    code: str, c: ContainerDep, authorization: Annotated[str | None, Header()] = None
) -> IceResponse:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise Unauthorized()
    claims = decode_room_token(c.settings, token)
    room = await c.rooms.get_room(code)
    if claims.room != room.code:
        raise Unauthorized("Token was issued for a different room")
    return IceResponse(
        ice_servers=ice_servers_for(c.settings, claims.sub), expires_in=c.settings.turn_ttl_seconds
    )


@router.post("/{code}/invite", response_model=InviteResponse, dependencies=[Lookup])
async def invite(
    code: str, body: InviteRequest, request: Request, c: ContainerDep
) -> InviteResponse | JSONResponse:
    telegram = telegram_of(c)
    caller = linked_of(request, c)
    if caller is None:
        raise TelegramNotLinked()
    try:
        status = await telegram.invite(code, caller, body.target)
    except TelegramNotLinked as exc:
        # notify forgot them (/stop in the bot): drop the cookie
        response = await kolo_error_handler(request, exc)
        forget(response, request, c)
        return response
    return InviteResponse(status=status)
