# src/kolo/core/security.py

"""Tokens, secret hashing, safe compare."""
import hashlib
import hmac
import secrets
import time

import jwt
from pydantic import BaseModel

from kolo.core.config import Settings
from kolo.domain.errors import Unauthorized
from kolo.domain.models import Role

JWT_ALGORITHM = "HS256"

class RoomTokenClaims(BaseModel):
    sub: str  # participant id
    room: str  # room code
    name: str
    role: Role
    iat: int
    exp: int

def new_secret() -> str:
    """256 bits of randomness, url-safe."""
    return secrets.token_urlsafe(32)

def new_participant_id() -> str:
    return "p_" + secrets.token_hex(8)

def hash_secret(secret: str) -> str:
    # secret is long and random, plain sha256 is enough
    return hashlib.sha256(secret.encode()).hexdigest()

def verify_secret(secret: str, expected_hash: str) -> bool:
    return hmac.compare_digest(hash_secret(secret), expected_hash)

def create_room_token(
    settings: Settings, *, room: str, participant_id: str, name: str, role: Role
) -> str:
    now = int(time.time())
    claims = RoomTokenClaims(
        sub=participant_id, 
        room=room, 
        name=name, 
        role=role,
        iat=now, 
        exp=now + settings.jwt_ttl_seconds,
    )
    return jwt.encode(
        claims.model_dump(mode="json"),
        settings.jwt_secret.get_secret_value(),
        algorithm=JWT_ALGORITHM,
    )

def decode_room_token(settings: Settings, token: str) -> RoomTokenClaims:
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret.get_secret_value(),
            algorithms=[JWT_ALGORITHM],  # fixed alg, blocks alg=none
            options={"require": ["exp", "sub", "room"]},
        )
    except jwt.PyJWTError as exc:
        raise Unauthorized("Invalid or expired token") from exc
        
    return RoomTokenClaims.model_validate(payload)

def check_api_key(settings: Settings, provided: str | None) -> bool:
    if not provided:
        return False
    return any(
        hmac.compare_digest(provided.encode(), key.get_secret_value().encode())
        for key in settings.api_keys
    )