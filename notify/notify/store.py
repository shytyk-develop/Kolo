from __future__ import annotations

import contextlib
import math
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import asyncpg

# libpq-only params asyncpg rejects (Neon adds channel_binding)
_LIBPQ_ONLY = {"channel_binding", "gssencmode", "target_session_attrs"}

LINK_TTL = timedelta(minutes=10)

# per caller
HOURLY_LIMIT = 30
HOURLY_UNKNOWN_LIMIT = 3
PAIR_WINDOW = timedelta(minutes=2)


def asyncpg_dsn(url: str) -> str:
    parts = urlsplit(url)
    scheme = "postgresql" if parts.scheme in ("postgres", "postgresql", "postgresql+asyncpg") else parts.scheme
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k not in _LIBPQ_ONLY]
    return urlunsplit((scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


async def connect(url: str) -> asyncpg.Connection:
    # the PgBouncer pooler can't keep prepared statements
    return await asyncpg.connect(asyncpg_dsn(url), statement_cache_size=0, timeout=5, command_timeout=10)


@dataclass(frozen=True, slots=True)
class User:
    handle: str
    chat_id: int
    display_name: str
    lang: str
    bot_blocked: bool


@dataclass(frozen=True, slots=True)
class ChatState:
    chat_id: int
    step: str
    link_token: str | None


@dataclass(frozen=True, slots=True)
class Invite:
    id: uuid.UUID
    caller: str
    caller_name: str
    target: str
    room: str
    known: bool
    chat_id: int | None
    message_id: int | None
    status: str


@dataclass(frozen=True, slots=True)
class Limit:
    reason: str
    retry_after: int


def _user(row: Any) -> User | None:
    return User(**dict(row)) if row else None


class Store:
    def __init__(self, conn: asyncpg.Connection) -> None:
        self.conn = conn

    def transaction(self) -> Any:
        return self.conn.transaction()

    async def user(self, handle: str) -> User | None:
        return _user(await self.conn.fetchrow(
            "select handle, chat_id, display_name, lang, bot_blocked from users where handle = $1", handle
        ))

    async def user_by_chat(self, chat_id: int) -> User | None:
        return _user(await self.conn.fetchrow(
            "select handle, chat_id, display_name, lang, bot_blocked from users where chat_id = $1", chat_id
        ))

    async def create_user(self, handle: str, chat_id: int, display_name: str, lang: str) -> bool:
        # False if taken
        try:
            await self.conn.execute(
                "insert into users (handle, chat_id, display_name, lang) values ($1, $2, $3, $4)",
                handle, chat_id, display_name, lang,
            )
        except asyncpg.UniqueViolationError:
            return False
        return True

    async def rename_user(self, chat_id: int, handle: str) -> bool:
        # False if taken; pairs and blocks follow via on update cascade
        try:
            await self.conn.execute("update users set handle = $2 where chat_id = $1", chat_id, handle)
        except asyncpg.UniqueViolationError:
            return False
        return True

    async def touch_user(self, chat_id: int, display_name: str, lang: str) -> None:
        # writing to the bot again = not blocked anymore
        await self.conn.execute(
            "update users set display_name = coalesce(nullif($2, ''), display_name), lang = $3,"
            " bot_blocked = false where chat_id = $1",
            chat_id, display_name, lang,
        )

    async def mark_bot_blocked(self, handle: str) -> None:
        await self.conn.execute("update users set bot_blocked = true where handle = $1", handle)

    async def delete_chat(self, chat_id: int) -> None:
        async with self.conn.transaction():
            handle = await self.conn.fetchval("select handle from users where chat_id = $1", chat_id)
            await self.conn.execute(
                "delete from invites where chat_id = $1 or caller = $2 or target = $2", chat_id, handle
            )
            await self.conn.execute("delete from users where chat_id = $1", chat_id)
            await self.conn.execute("delete from chat_states where chat_id = $1", chat_id)

    async def delete_handle(self, handle: str) -> None:
        async with self.conn.transaction():
            chat_id = await self.conn.fetchval("select chat_id from users where handle = $1", handle)
            await self.conn.execute("delete from invites where caller = $1 or target = $1", handle)
            if chat_id is not None:
                await self.delete_chat(chat_id)

    async def state(self, chat_id: int) -> ChatState | None:
        row = await self.conn.fetchrow(
            "select chat_id, step, link_token from chat_states where chat_id = $1", chat_id
        )
        return ChatState(**dict(row)) if row else None

    async def set_state(self, chat_id: int, step: str, link_token: str | None = None) -> None:
        await self.conn.execute(
            "insert into chat_states (chat_id, step, link_token) values ($1, $2, $3)"
            " on conflict (chat_id) do update set step = $2, link_token = $3, updated_at = now()",
            chat_id, step, link_token,
        )

    async def clear_state(self, chat_id: int) -> None:
        await self.conn.execute("delete from chat_states where chat_id = $1", chat_id)

    async def new_link_token(self, token: str) -> None:
        # prune old tokens while here
        await self.conn.execute("delete from link_tokens where expires_at < now() - interval '1 day'")
        await self.conn.execute(
            "insert into link_tokens (token, expires_at) values ($1, now() + $2::interval)", token, LINK_TTL
        )

    async def link_token_open(self, token: str) -> bool:
        return bool(await self.conn.fetchval(
            "select 1 from link_tokens where token = $1 and used_at is null and expires_at > now()", token
        ))

    async def bind_link_token(self, token: str, handle: str) -> bool:
        return bool(await self.conn.fetchval(
            "update link_tokens set used_at = now(), handle = $2"
            " where token = $1 and used_at is null and expires_at > now() returning 1",
            token, handle,
        ))

    async def link_status(self, token: str) -> dict[str, Any] | None:
        row = await self.conn.fetchrow(
            "select t.used_at, t.expires_at > now() as open, u.handle, u.display_name"
            " from link_tokens t left join users u on u.handle = t.handle where t.token = $1",
            token,
        )
        if row is None:
            return None
        if row["used_at"] is not None and row["handle"]:
            return {"status": "linked", "handle": row["handle"], "display_name": row["display_name"]}
        return {"status": "pending" if row["open"] and row["used_at"] is None else "expired"}

    async def is_known(self, a: str, b: str) -> bool:
        return bool(await self.conn.fetchval(
            "select 1 from known_pairs where least(a, b) = least($1::text, $2::text)"
            " and greatest(a, b) = greatest($1::text, $2::text)",
            a, b,
        ))

    async def add_pair(self, a: str, b: str) -> None:
        if a == b:
            return
        # one of them may be deleted right now
        with contextlib.suppress(asyncpg.ForeignKeyViolationError):
            await self.conn.execute(
                "insert into known_pairs (a, b) select least($1::text, $2::text), greatest($1::text, $2::text)"
                " where exists (select 1 from users where handle = $1)"
                " and exists (select 1 from users where handle = $2)"
                " on conflict do nothing",
                a, b,
            )

    async def is_blocked(self, blocker: str, blocked: str) -> bool:
        return bool(await self.conn.fetchval(
            "select 1 from blocks where blocker = $1 and blocked = $2", blocker, blocked
        ))

    async def add_block(self, blocker: str, blocked: str) -> None:
        with contextlib.suppress(asyncpg.ForeignKeyViolationError):
            await self.conn.execute(
                "insert into blocks (blocker, blocked) select $1, $2"
                " where exists (select 1 from users where handle = $2) on conflict do nothing",
                blocker, blocked,
            )

    async def lock_caller(self, caller: str) -> None:
        # one invite per caller at a time, so limits can't be raced
        await self.conn.execute("select pg_advisory_xact_lock(hashtext('invite:' || $1))", caller)

    async def invite_limit(self, caller: str, target: str, known: bool) -> Limit | None:
        # the broken limit and seconds until it frees up, or None
        row = await self.conn.fetchrow(
            """
            select now() as now,
              min(created_at) filter (
                where target = $2 and created_at > now() - $3::interval
                  and status <> 'ended' and not (status = 'failed' and known)
              ) as pair,
              count(*) as total,
              min(created_at) as total_oldest,
              count(*) filter (where not known) as unknown,
              min(created_at) filter (where not known) as unknown_oldest
            from invites where caller = $1 and created_at > now() - interval '1 hour'
            """,
            caller, target, PAIR_WINDOW,
        )
        now: datetime = row["now"]

        def wait(since: datetime, window: timedelta) -> int:
            return max(1, math.ceil((since + window - now).total_seconds()))

        if row["pair"] is not None:
            return Limit("pair", wait(row["pair"], PAIR_WINDOW))
        if row["total"] >= HOURLY_LIMIT:
            return Limit("hourly", wait(row["total_oldest"], timedelta(hours=1)))
        if not known and row["unknown"] >= HOURLY_UNKNOWN_LIMIT:
            return Limit("hourly_unknown", wait(row["unknown_oldest"], timedelta(hours=1)))
        return None

    async def insert_invite(
        self, caller: str, caller_name: str, target: str, room: str, known: bool, status: str
    ) -> uuid.UUID:
        invite_id = uuid.uuid4()
        await self.conn.execute(
            "insert into invites (id, caller, caller_name, target, room, known, status)"
            " values ($1, $2, $3, $4, $5, $6, $7)",
            invite_id, caller, caller_name, target, room, known, status,
        )
        return invite_id

    async def invite(self, invite_id: uuid.UUID | str) -> Invite | None:
        try:
            key = invite_id if isinstance(invite_id, uuid.UUID) else uuid.UUID(invite_id)
        except ValueError:
            return None
        row = await self.conn.fetchrow(
            "select id, caller, caller_name, target, room, known, chat_id, message_id, status"
            " from invites where id = $1",
            key,
        )
        return Invite(**dict(row)) if row else None

    async def set_invite(
        self, invite_id: uuid.UUID, status: str, *, chat_id: int | None = None, message_id: int | None = None
    ) -> None:
        await self.conn.execute(
            "update invites set status = $2, chat_id = coalesce($3, chat_id),"
            " message_id = coalesce($4, message_id) where id = $1",
            invite_id, status, chat_id, message_id,
        )
