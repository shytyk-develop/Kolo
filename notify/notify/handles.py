from __future__ import annotations

import re
from typing import Literal

HANDLE_RE = re.compile(r"^[a-z0-9_]{3,20}$")
# same format as the Kolo backend
ROOM_RE = re.compile(r"^[a-z]{3}-[a-z]{4}-[a-z]{3}$")

RESERVED = frozenset(
    {
        "abuse", "admin", "administrator", "all", "api", "bot", "contact", "everyone", "help",
        "helpdesk", "info", "login", "mail", "me", "mod", "moderator", "none", "null", "official",
        "rename", "root", "security", "settings", "signup", "staff", "start", "stop", "support",
        "system", "team", "telegram", "undefined", "www", "you",
    }
)
# nobody gets to look official
RESERVED_PREFIX = "kolo"

HandleProblem = Literal["format", "reserved"]


def normalize_handle(raw: str) -> str:
    return raw.strip().removeprefix("@").lower()


def is_handle(handle: str) -> bool:
    return bool(HANDLE_RE.fullmatch(handle))


def handle_problem(handle: str) -> HandleProblem | None:
    if not is_handle(handle):
        return "format"
    if handle in RESERVED or handle.startswith(RESERVED_PREFIX):
        return "reserved"
    return None


def is_room_code(code: str) -> bool:
    return bool(ROOM_RE.fullmatch(code))
