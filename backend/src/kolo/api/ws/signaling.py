# src/kolo/api/ws/signaling.py

from fastapi import APIRouter, Query, WebSocket

from kolo.core.logging import log
from kolo.core.security import decode_room_token
from kolo.domain.errors import KoloError, RoomExpired, RoomNotFound, Unauthorized
from kolo.domain.models import Peer
from kolo.infra.errors import DEPENDENCY_ERROR_TYPES, is_dependency_error
from kolo.services.signaling.session import (
    CLOSE_FORBIDDEN,
    CLOSE_GONE,
    CLOSE_NOT_FOUND,
    CLOSE_OVERLOADED,
    CLOSE_UNAUTHORIZED,
    REASON_UNAVAILABLE,
    PeerSession,
)

router = APIRouter()

# domain error -> ws close code
CLOSE_CODES = {
    Unauthorized: CLOSE_UNAUTHORIZED, 
    RoomNotFound: CLOSE_NOT_FOUND,
    RoomExpired: CLOSE_GONE
}

@router.websocket("/ws/rooms/{code}")
async def signaling(
    websocket: WebSocket, 
    code: str, 
    token: str = Query(default="")
) -> None:
    c = websocket.app.state.container
    
    # other sites can't open our ws (CSWSH), browsers always send Origin
    origin = websocket.headers.get("origin")
    if origin is not None and origin not in c.settings.cors_origins:
        await websocket.close(code=CLOSE_FORBIDDEN)
        return
        
    await websocket.accept()
    
    try:
        # who is this
        claims = decode_room_token(c.settings, token)
        room = await c.rooms.get_room(code)
        
        if claims.room != room.code:
            raise Unauthorized("Token was issued for a different room")
            
    except KoloError as exc:
        # bad token, no room, expired room...
        await websocket.close(
            code=CLOSE_CODES.get(type(exc), CLOSE_FORBIDDEN), 
            reason=exc.code
        )
        return
    except DEPENDENCY_ERROR_TYPES as exc:
        if not is_dependency_error(exc):
            raise

        # redis or db is down, client should retry
        log.warning("dependency_unavailable", path=websocket.url.path, error=repr(exc))
        await websocket.close(code=CLOSE_OVERLOADED, reason=REASON_UNAVAILABLE)
        return
        
    # hand off to the session
    session = PeerSession(
        websocket, 
        room, 
        Peer(id=claims.sub, name=claims.name, role=claims.role, client_id=claims.cid, handle=claims.tg),
        hub=c.hub, 
        presence=c.presence, 
        settings=c.settings, 
        events=c.events,
        telegram=c.telegram,
    )
    
    # runs until disconnect
    await session.run()