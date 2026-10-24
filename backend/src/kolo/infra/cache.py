# src/kolo/infra/cache.py

"""Simple key -> string cache with a TTL. Two implementations: in-memory and Redis."""
import time
from typing import Protocol

from redis.asyncio import Redis


class Cache(Protocol):
    async def get(self, key: str) -> str | None: ...
    async def set(self, key: str, value: str, ttl_seconds: int) -> None: ...
    async def delete(self, key: str) -> None: ...


class MemoryCache:
    def __init__(self) -> None:
        self._data: dict[str, tuple[float, str]] = {}

    async def get(self, key: str) -> str | None:
        item = self._data.get(key)
        if item is None:
            return None

        expires_at, value = item
        if time.monotonic() >= expires_at:
            del self._data[key]
            return None
        return value

    async def set(self, key: str, value: str, ttl_seconds: int) -> None:
        self._data[key] = (time.monotonic() + ttl_seconds, value)

    async def delete(self, key: str) -> None:
        self._data.pop(key, None)


class RedisCache:
    def __init__(self, redis: Redis) -> None:
        self._redis = redis

    async def get(self, key: str) -> str | None:
        return await self._redis.get(key)

    async def set(self, key: str, value: str, ttl_seconds: int) -> None:
        await self._redis.set(key, value, ex=ttl_seconds)

    async def delete(self, key: str) -> None:
        await self._redis.delete(key)
