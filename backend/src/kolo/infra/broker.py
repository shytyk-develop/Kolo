# src/kolo/infra/broker.py (Part 1)

"""Message broker: pub/sub mechanism to broadcast and listen to channels."""

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Protocol
from redis.asyncio import Redis

class Broker(Protocol):
    async def publish(self, channel: str, message: dict) -> None: ...
    
    def subscribe(self, channel: str):
        """Async context manager. When entered, the subscription is active."""
        ...

class MemoryBroker:
    """Fake in-memory broker using asyncio queues. Good for single-process testing."""
    
    def __init__(self) -> None:
        # map channel names to a set of subscriber queues
        self._subscribers: dict[str, set[asyncio.Queue[dict]]] = {}
        
    async def publish(self, channel: str, message: dict) -> None:
        # push the message to everyone currently listening on this channel
        for queue in list(self._subscribers.get(channel, ())):
            queue.put_nowait(message)
            
    @asynccontextmanager
    async def subscribe(self, channel: str):
        queue: asyncio.Queue[dict] = asyncio.Queue()
        self._subscribers.setdefault(channel, set()).add(queue)
        
        async def messages() -> AsyncIterator[dict]:
            # just sit here and yield messages as they arrive in the queue
            while True:
                yield await queue.get()
                
        try:
            # hand the iterator back to the caller
            yield messages()
        finally:
            # cleanup when the caller disconnects or stops listening
            subs = self._subscribers.get(channel)
            if subs is not None:
                subs.discard(queue)
                # don't leave empty sets hanging around in memory
                if not subs:
                    del self._subscribers[channel]


class RedisBroker:
    """Pub/Sub bus between processes. Delivery is at-most-once, which is acceptable for signaling."""

    def __init__(self, redis: Redis) -> None:
        self._redis = redis

    async def publish(self, channel: str, message: dict) -> None:
        await self._redis.publish(channel, json.dumps(message))

    @asynccontextmanager
    async def subscribe(self, channel: str):
        pubsub = self._redis.pubsub()
        await pubsub.subscribe(channel)

        # wait for the confirmation, otherwise the first messages could get lost
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
