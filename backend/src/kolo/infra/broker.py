# src/kolo/infra/broker.py

"""Pub/sub: publish to a channel, listen to a channel."""

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Protocol

from redis.asyncio import Redis


class Broker(Protocol):
    async def publish(self, channel: str, message: dict) -> None: ...
    
    def subscribe(self, channel: str):
        """Context manager, subscribed while inside."""
        ...

class MemoryBroker:
    """In-memory broker on asyncio queues, one process only."""
    
    def __init__(self) -> None:
        # channel -> subscriber queues
        self._subscribers: dict[str, set[asyncio.Queue[dict]]] = {}
        
    async def publish(self, channel: str, message: dict) -> None:
        # send to everyone on the channel
        for queue in list(self._subscribers.get(channel, ())):
            queue.put_nowait(message)
            
    @asynccontextmanager
    async def subscribe(self, channel: str):
        queue: asyncio.Queue[dict] = asyncio.Queue()
        self._subscribers.setdefault(channel, set()).add(queue)
        
        async def messages() -> AsyncIterator[dict]:
            # yield messages as they come
            while True:
                yield await queue.get()
                
        try:
            yield messages()
        finally:
            # caller stopped listening
            subs = self._subscribers.get(channel)
            if subs is not None:
                subs.discard(queue)
                # drop empty sets
                if not subs:
                    del self._subscribers[channel]


class RedisBroker:
    """Redis pub/sub between processes, at-most-once (fine for signaling)."""

    def __init__(self, redis: Redis) -> None:
        self._redis = redis

    async def publish(self, channel: str, message: dict) -> None:
        await self._redis.publish(channel, json.dumps(message))

    @asynccontextmanager
    async def subscribe(self, channel: str):
        pubsub = self._redis.pubsub()
        await pubsub.subscribe(channel)

        # wait for the subscribe confirm, or the first messages get lost
        while True:
            confirm = await pubsub.get_message(timeout=1.0)
            if confirm and confirm["type"] == "subscribe":
                break

        async def messages() -> AsyncIterator[dict]:
            async for item in pubsub.listen():
                if item["type"] == "message":
                    yield json.loads(item["data"])

        try:
            yield messages()
        finally:
            await pubsub.unsubscribe(channel)
            await pubsub.aclose()
