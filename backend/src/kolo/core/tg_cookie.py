"""The kolo_tg cookie: which Kolo ID this browser linked, signed with SESSION_SECRET."""

import base64
import hashlib
import hmac
import json
import re
import time
from dataclasses import dataclass

COOKIE = "kolo_tg"
# ties a link token to the browser that asked for it
PENDING_COOKIE = "kolo_tg_link"
MAX_AGE = 180 * 24 * 3600
PENDING_MAX_AGE = 10 * 60

HANDLE_RE = re.compile(r"^[a-z0-9_]{3,20}$")


@dataclass(frozen=True, slots=True)
class Linked:
    handle: str
    name: str


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _mac(secret: str, purpose: str, body: str) -> str:
    return _b64(hmac.new(secret.encode(), f"{purpose}|{body}".encode(), hashlib.sha256).digest())


def sign_linked(secret: str, linked: Linked, now: float | None = None) -> str:
    body = _b64(json.dumps({"h": linked.handle, "n": linked.name, "t": int(now or time.time())}).encode())
    return f"{body}.{_mac(secret, COOKIE, body)}"


def read_linked(secret: str, value: str | None, now: float | None = None) -> Linked | None:
    """None for anything missing, tampered, expired or malformed."""
    if not value or value.count(".") != 1:
        return None
    body, mac = value.split(".")
    if not hmac.compare_digest(_mac(secret, COOKIE, body), mac):
        return None
    try:
        data = json.loads(_unb64(body))
        handle, name, issued = data["h"], data["n"], int(data["t"])
    except (ValueError, KeyError, TypeError):
        return None
    if not isinstance(handle, str) or not HANDLE_RE.fullmatch(handle) or not isinstance(name, str):
        return None
    if (now or time.time()) - issued > MAX_AGE:
        return None
    return Linked(handle, name)


def sign_pending(secret: str, token: str) -> str:
    return _mac(secret, PENDING_COOKIE, token)


def pending_matches(secret: str, token: str, value: str | None) -> bool:
    return bool(value) and hmac.compare_digest(sign_pending(secret, token), value)
