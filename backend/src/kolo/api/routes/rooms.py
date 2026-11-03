from typing import Annotated

from fastapi import APIRouter, Header, Request

from kolo.api.deps import ContainerDep, client_ip
from kolo.core.security import check_api_key
from kolo.domain.errors import RateLimited, Unauthorized
from kolo.schemas.rooms import CreateRoomRequest, JoinRequest, JoinResponse, RoomCreatedResponse
from kolo.services.sfu import sfu_token, uses_sfu

router = APIRouter(tags=["rooms"])

@router.post("", status_code=201, response_model=RoomCreatedResponse)
async def create_room(
    body: CreateRoomRequest,
    request: Request,
    c: ContainerDep,
    x_api_key: Annotated[str | None, Header()] = None,
) -> RoomCreatedResponse:
    # Проверяем API-ключ
    trusted = check_api_key(c.settings, x_api_key)
    
    if c.settings.require_api_key and not trusted:
        raise Unauthorized("Нужен заголовок X-API-Key")
        
    # Если это не наш доверенный сервис - списываем жетон
    if not trusted and not c.room_limiter.allow(client_ip(request)):
        raise RateLimited()
        
    # ИСПРАВЛЕНИЕ: Сохраняем объект целиком в переменную created
    created = await c.rooms.create_room(body.name, body.max_participants, body.lobby_enabled)
    
    return RoomCreatedResponse(
        code=created.room.code,
        name=created.room.name,
        join_url=f"{c.settings.frontend_url}/r/{created.room.code}",
        host_secret=created.host_secret,  # Достаем секрет через точку
        max_participants=created.room.max_participants,
        lobby_enabled=created.room.lobby_enabled,
        expires_at=created.room.expires_at,
    )

@router.post("/{code}/join", response_model=JoinResponse, response_model_exclude_none=True)
async def join_room(code: str, body: JoinRequest, c: ContainerDep) -> JoinResponse:
    ticket = await c.rooms.join(code, body.display_name, body.host_secret)

    media: dict = {}
    if uses_sfu(c.settings, ticket.room):
        media = {"media_mode": "sfu", "sfu_url": c.settings.livekit_url}
        # LiveKit knows nothing about our lobby: a token handed out here would let a guest skip it.
        # guests who need admission get theirs in the welcome message, see PeerSession._join
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