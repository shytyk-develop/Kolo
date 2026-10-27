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

# map our domain errors to custom websocket close codes
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
    
    # protect against Cross-Site WebSocket Hijacking (CSWSH).
    # browsers always send the Origin header for WebSockets, so we verify it.
    origin = websocket.headers.get("origin")
    if origin is not None and origin not in c.settings.cors_origins:
        await websocket.close(code=CLOSE_FORBIDDEN)
        return
        
    await websocket.accept()
    
    try:
        # decode the JWT to figure out who is knocking
        claims = decode_room_token(c.settings, token)
        room = await c.rooms.get_room(code)
        
        if claims.room != room.code:
            raise Unauthorized("Token was issued for a different room")
            
    except KoloError as exc:
        # bounce them if the token is garbage, room is dead, etc.
        await websocket.close(
            code=CLOSE_CODES.get(type(exc), CLOSE_FORBIDDEN), 
            reason=exc.code
        )
        return
    except DEPENDENCY_ERROR_TYPES as exc:
        if not is_dependency_error(exc):
            raise

        # couldn't load the room: Redis or the database is down, the client should retry later
        log.warning("dependency_unavailable", path=websocket.url.path, error=repr(exc))
        await websocket.close(code=CLOSE_OVERLOADED, reason=REASON_UNAVAILABLE)
        return
        
    # bundle everything up and hand off control to the session manager
    session = PeerSession(
        websocket, 
        room, 
        Peer(id=claims.sub, name=claims.name, role=claims.role),
        hub=c.hub, 
        presence=c.presence, 
        settings=c.settings, 
        events=c.events,
    )
    
    # this will block and handle the websocket lifecycle until they disconnect
    await session.run()