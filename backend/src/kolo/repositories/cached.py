# src/kolo/repositories/cached.py

"""Cache-aside: cache first, on miss read the db and cache it."""
import json
from dataclasses import asdict
from datetime import datetime

from kolo.domain.models import Room
from kolo.infra.cache import Cache
from kolo.repositories.base import RoomRepository


def _dump(room: Room) -> str:
    data = asdict(room)
    data["created_at"] = room.created_at.isoformat()
    data["expires_at"] = room.expires_at.isoformat()
    return json.dumps(data)


def _load(raw: str) -> Room:
    data = json.loads(raw)
    data["created_at"] = datetime.fromisoformat(data["created_at"])
    data["expires_at"] = datetime.fromisoformat(data["expires_at"])
    return Room(**data)


class CachedRoomRepository:
    def __init__(self, inner: RoomRepository, cache: Cache, ttl_seconds: int = 60) -> None:
        self._inner, self._cache, self._ttl = inner, cache, ttl_seconds
        self.hits = 0
        self.misses = 0

    async def add(self, room: Room) -> None:
        await self._inner.add(room)
        await self._cache.set(f"room:{room.code}:meta", _dump(room), self._ttl)

    async def get_by_code(self, code: str) -> Room | None:
        cached = await self._cache.get(f"room:{code}:meta")
        if cached is not None:
            self.hits += 1
            return _load(cached)

        self.misses += 1
        room = await self._inner.get_by_code(code)
        if room is not None:
            await self._cache.set(f"room:{code}:meta", _dump(room), self._ttl)
        return room

    async def set_lobby(self, code: str, enabled: bool) -> Room | None:
        room = await self._inner.set_lobby(code, enabled)
        # new joins must see it at once, not after the cache ttl
        if room is not None:
            await self._cache.set(f"room:{code}:meta", _dump(room), self._ttl)
        return room

    async def delete_expired(self, older_than: datetime) -> int:
        # room_cleaner calls this on the outer repo, so pass it through.
        # stale cache dies by ttl, expired rooms are rejected by RoomService anyway
        delete_expired = getattr(self._inner, "delete_expired", None)
        return await delete_expired(older_than) if delete_expired else 0

    async def add_invite(self, code: str, invite_id: str) -> None:
        await self._inner.add_invite(code, invite_id)

    async def take_invites(self, code: str) -> list[str]:
        return await self._inner.take_invites(code)

    async def take_expired_invites(self, now: datetime) -> list[str]:
        return await self._inner.take_expired_invites(now)
