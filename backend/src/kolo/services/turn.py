# src/kolo/services/turn.py

"""
Temporary TURN logins, the "TURN REST API" scheme (draft-uberti-behave-turn-rest).
coturn with the use-auth-secret option checks:
    username   = "<unix expiry time>:<any id>"
    credential = base64(HMAC-SHA1(secret, username))
Only our backend and coturn know the secret. A login expires on its own, no passwords are stored.
"""
import base64
import hashlib
import hmac
import time

from kolo.core.config import Settings


def turn_credentials(
    secret: str, user_id: str, ttl_seconds: int, now: float | None = None
) -> tuple[str, str]:
    expires_at = int((now if now is not None else time.time()) + ttl_seconds)
    username = f"{expires_at}:{user_id}"
    # SHA-1 collisions don't break HMAC, and this is the algorithm coturn requires
    digest = hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()
    return username, base64.b64encode(digest).decode()


def ice_servers_for(settings: Settings, participant_id: str) -> list[dict]:
    servers: list[dict] = []

    if settings.stun_urls:
        servers.append({"urls": settings.stun_urls})

    if settings.turn_urls and settings.turn_secret:
        username, credential = turn_credentials(
            settings.turn_secret.get_secret_value(), participant_id, settings.turn_ttl_seconds
        )
        servers.append({"urls": settings.turn_urls, "username": username, "credential": credential})

    return servers
