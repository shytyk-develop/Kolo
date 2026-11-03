# src/kolo/infra/presence.py (Part 1: Protocol and in-memory implementation)

import json
import time
from typing import Protocol

from redis.asyncio import Redis

from kolo.domain.models import Peer

KEY_TTL_SECONDS = 24 * 60 * 60

class PresenceStore(Protocol):
    # interface defining how we track who is in which room
    async def add(self, room: str, peer: Peer) -> int: ...
    async def remove(self, room: str, peer_id: str) -> None: ...
    async def touch(self, room: str, peer_id: str) -> None: ...
    async def members(self, room: str) -> list[Peer]: ...
    async def count(self, room: str) -> int: ...
    
    # lobby stuff
    async def add_waiting(self, room: str, peer: Peer) -> None: ...
    async def remove_waiting(self, room: str, peer_id: str) -> None: ...
    async def list_waiting(self, room: str) -> list[Peer]: ...
    async def admit(self, room: str, peer_id: str) -> None: ...
    async def is_admitted(self, room: str, peer_id: str) -> bool: ...


class MemoryPresence:
    """Fake in-memory presence store. Good for local testing without Redis."""
    
    def __init__(self, ttl_seconds: int = 60, clock=time.time) -> None:
        self._ttl = ttl_seconds
        self._clock = clock
        self._peers: dict[str, dict[str, tuple[float, Peer]]] = {}
        self._lobby: dict[str, dict[str, Peer]] = {}
        self._admitted: dict[str, set[str]] = {}

    def _alive(self, room: str) -> dict[str, tuple[float, Peer]]:
        # helper to sweep dead peers who haven't pinged us recently
        peers = self._peers.setdefault(room, {})
        deadline = self._clock() - self._ttl
        
        for pid in [pid for pid, (seen, _) in peers.items() if seen < deadline]:
            del peers[pid]
            
        return peers

    async def add(self, room: str, peer: Peer) -> int:
        peers = self._alive(room)
        peers[peer.id] = (self._clock(), peer)
        return len(peers)

    async def remove(self, room: str, peer_id: str) -> None:
        self._peers.get(room, {}).pop(peer_id, None)

    async def touch(self, room: str, peer_id: str) -> None:
        # heartbeat: keep the peer alive so they don't get swept away
        peers = self._peers.get(room, {})
        if peer_id in peers:
            peers[peer_id] = (self._clock(), peers[peer_id][1])

    async def members(self, room: str) -> list[Peer]:
        return [peer for _, peer in self._alive(room).values()]

    async def count(self, room: str) -> int:
        return len(self._alive(room))

    # lobby stuff will be used in chapter 11, but setting up the stubs now
    async def add_waiting(self, room: str, peer: Peer) -> None:
        self._lobby.setdefault(room, {})[peer.id] = peer

    async def remove_waiting(self, room: str, peer_id: str) -> None:
        self._lobby.get(room, {}).pop(peer_id, None)

    async def list_waiting(self, room: str) -> list[Peer]:
        return list(self._lobby.get(room, {}).values())

    async def admit(self, room: str, peer_id: str) -> None:
        self._admitted.setdefault(room, set()).add(peer_id)

    async def is_admitted(self, room: str, peer_id: str) -> bool:
        return peer_id in self._admitted.get(room, set())


class RedisPresence:
    """Sorted set of peers scored by last ping time, so dropping silent peers is one range query."""

    def __init__(self, redis: Redis, ttl_seconds: int = 60, clock=time.time) -> None:
        self._r = redis
        self._ttl = ttl_seconds
        self._clock = clock

    @staticmethod
    def _keys(room: str) -> tuple[str, str]:
        return f"room:{room}:peers", f"room:{room}:info"

    async def _cleanup(self, room: str) -> None:
        peers_key, info_key = self._keys(room)
        deadline = self._clock() - self._ttl
        stale = await self._r.zrangebyscore(peers_key, "-inf", deadline)
        if stale:
            async with self._r.pipeline(transaction=True) as pipe:
                pipe.zrem(peers_key, *stale)
                pipe.hdel(info_key, *stale)
                await pipe.execute()

    async def add(self, room: str, peer: Peer) -> int:
        peers_key, info_key = self._keys(room)
        await self._cleanup(room)

        # MULTI ... EXEC: nobody can squeeze in between ZADD and ZCARD
        async with self._r.pipeline(transaction=True) as pipe:
            pipe.zadd(peers_key, {peer.id: self._clock()})
            pipe.hset(info_key, peer.id, json.dumps(peer.to_dict()))
            pipe.expire(peers_key, KEY_TTL_SECONDS)
            pipe.expire(info_key, KEY_TTL_SECONDS)
            pipe.zcard(peers_key)
            *_, count = await pipe.execute()
        return int(count)

    async def remove(self, room: str, peer_id: str) -> None:
        peers_key, info_key = self._keys(room)
        async with self._r.pipeline(transaction=True) as pipe:
            pipe.zrem(peers_key, peer_id)
            pipe.hdel(info_key, peer_id)
            await pipe.execute()

    async def touch(self, room: str, peer_id: str) -> None:
        peers_key, _ = self._keys(room)
        # xx: only update existing members, a late ping must not resurrect a removed peer
        await self._r.zadd(peers_key, {peer_id: self._clock()}, xx=True)

    async def members(self, room: str) -> list[Peer]:
        _, info_key = self._keys(room)
        await self._cleanup(room)
        raw = await self._r.hgetall(info_key)
        return [Peer.from_dict(json.loads(value)) for value in raw.values()]

    async def count(self, room: str) -> int:
        await self._cleanup(room)
        return int(await self._r.zcard(self._keys(room)[0]))

    async def add_waiting(self, room: str, peer: Peer) -> None:
        key = f"room:{room}:lobby"
        await self._r.hset(key, peer.id, json.dumps(peer.to_dict()))
        await self._r.expire(key, KEY_TTL_SECONDS)

    async def remove_waiting(self, room: str, peer_id: str) -> None:
        await self._r.hdel(f"room:{room}:lobby", peer_id)

    async def list_waiting(self, room: str) -> list[Peer]:
        raw = await self._r.hgetall(f"room:{room}:lobby")
        return [Peer.from_dict(json.loads(value)) for value in raw.values()]

    async def admit(self, room: str, peer_id: str) -> None:
        key = f"room:{room}:admitted"
        await self._r.sadd(key, peer_id)
        await self._r.expire(key, KEY_TTL_SECONDS)

    async def is_admitted(self, room: str, peer_id: str) -> bool:
        return bool(await self._r.sismember(f"room:{room}:admitted", peer_id))
