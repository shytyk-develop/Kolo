# tests/test_security.py

import time
import jwt
import pytest

from kolo.core.security import create_room_token, decode_room_token
from kolo.domain.errors import Unauthorized
from kolo.domain.models import Role

def test_token_roundtrip(settings):
    token = create_room_token(settings, room="abc-defg-hij", participant_id="p_1", name="Аня", role=Role.HOST)
    claims = decode_room_token(settings, token)
    assert (claims.sub, claims.room, claims.role) == ("p_1", "abc-defg-hij", Role.HOST)

def test_expired_token_rejected(settings):
    settings.jwt_ttl_seconds = -1  # Делаем токен сразу протухшим
    token = create_room_token(settings, room="abc-defg-hij", participant_id="p_1", name="Аня", role=Role.GUEST)
    with pytest.raises(Unauthorized):
        decode_room_token(settings, token)

def test_alg_none_rejected(settings):
    # Хакерский токен: пытаемся обмануть библиотеку, сказав, что алгоритм "none"
    forged = jwt.encode(
        {"sub": "p_1", "room": "abc-defg-hij", "name": "x", "role": "host", "iat": 0, "exp": int(time.time()) + 60}, 
        key=None, 
        algorithm="none"
    )
    with pytest.raises(Unauthorized):
        decode_room_token(settings, forged)