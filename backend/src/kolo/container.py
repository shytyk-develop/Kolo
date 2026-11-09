# src/kolo/container.py

"""Builds all app dependencies in one place."""
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from redis.asyncio import Redis
from sqlalchemy import text

from kolo.core.config import Settings
from kolo.db.session import make_engine, make_session_factory
from kolo.infra.broker import Broker, MemoryBroker, RedisBroker
from kolo.infra.cache import Cache, MemoryCache, RedisCache
from kolo.infra.presence import MemoryPresence, PresenceStore, RedisPresence
from kolo.infra.rate_limit import KeyedRateLimiter
from kolo.repositories.base import RoomRepository
from kolo.repositories.cached import CachedRoomRepository
from kolo.repositories.memory import InMemoryRoomRepository
from kolo.repositories.sql import SqlRoomRepository
from kolo.services.events import EventSink, NullEventSink, WebhookSender
from kolo.services.rooms import RoomService
from kolo.services.signaling.hub import SignalingHub

Check = Callable[[], Awaitable[None]]


@dataclass
class Container:
    settings: Settings
    repo: RoomRepository
    presence: PresenceStore  # who is in which room
    broker: Broker  # pub/sub between sessions
    hub: SignalingHub  # sends messages to local ws sessions
    rooms: RoomService
    events: EventSink  # analytics/audit events
    room_limiter: KeyedRateLimiter  # per ip limit for creating rooms
    checks: dict[str, Check] = field(default_factory=dict)  # readiness checks
    # cleanup callbacks (close db etc)
    closers: list[Callable[[], Awaitable[None]]] = field(default_factory=list)

    async def aclose(self) -> None:
        # on shutdown, in reverse order
        for close in reversed(self.closers):
            await close()


async def build_container(
    settings: Settings,
    *,
    redis_factory: Callable[[], Redis] | None = None,
    events: EventSink | None = None,
) -> Container:
    checks: dict[str, Check] = {}
    closers: list[Callable[[], Awaitable[None]]] = []

    # 1. redis or memory
    redis: Redis | None = None
    if redis_factory is not None:
        redis = redis_factory()
    elif settings.redis_url:
        redis = Redis.from_url(settings.redis_url, decode_responses=True)

    cache: Cache
    broker: Broker
    presence: PresenceStore
    if redis is not None:
        cache, broker = RedisCache(redis), RedisBroker(redis)
        presence = RedisPresence(redis, settings.presence_ttl_seconds)

        async def check_redis() -> None:
            await redis.ping()

        checks["redis"] = check_redis
        closers.append(redis.aclose)
    else:
        cache, broker = MemoryCache(), MemoryBroker()
        presence = MemoryPresence(settings.presence_ttl_seconds)

    # 2. real db or memory
    base_repo: RoomRepository
    if settings.database_url.startswith("memory"):
        base_repo = InMemoryRoomRepository()
    else:
        engine = make_engine(settings.database_url)
        base_repo = SqlRoomRepository(make_session_factory(engine))

        async def check_db() -> None:
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))

        checks["database"] = check_db
        closers.append(engine.dispose)

    repo = CachedRoomRepository(base_repo, cache, settings.room_cache_ttl_seconds)

    # 3. events: webhooks if configured
    if events is None:
        if settings.webhook_url:
            webhooks = WebhookSender(settings)
            closers.append(webhooks.aclose)
            events = webhooks
        else:
            events = NullEventSink()

    # bucket = limit per minute, refills every second
    per_minute = settings.rooms_per_minute_per_ip

    return Container(
        settings=settings,
        repo=repo,
        presence=presence,
        broker=broker,
        hub=SignalingHub(broker),
        rooms=RoomService(repo, settings, presence, events),
        events=events,
        room_limiter=KeyedRateLimiter(capacity=per_minute, rate=per_minute / 60),
        checks=checks,
        closers=closers,
    )
