# src/kolo/container.py

"""Wires all application dependencies together in one place (composition root)."""
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
from kolo.services.events import EventSink, NullEventSink
from kolo.services.rooms import RoomService
from kolo.services.signaling.hub import SignalingHub

Check = Callable[[], Awaitable[None]]


@dataclass
class Container:
    settings: Settings
    repo: RoomRepository
    presence: PresenceStore  # who is in which room right now
    broker: Broker  # pub/sub between sessions
    hub: SignalingHub  # routes messages to local WebSocket sessions
    rooms: RoomService
    events: EventSink  # analytics/audit events
    room_limiter: KeyedRateLimiter  # prevents IP spam for room creation
    checks: dict[str, Check] = field(default_factory=dict)  # readiness probes
    # keep track of cleanup stuff (like closing db connections)
    closers: list[Callable[[], Awaitable[None]]] = field(default_factory=list)

    async def aclose(self) -> None:
        # run all cleanups when the server stops, in reverse order of creation
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

    # 1. Redis or process memory
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

    # 2. Real database or process memory (handy for quick tests)
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

    # 3. Outgoing events (webhooks arrive in chapter 15)
    events = events or NullEventSink()

    # set up rate limiting: bucket size = max per min, refill rate = drops per sec
    per_minute = settings.rooms_per_minute_per_ip

    return Container(
        settings=settings,
        repo=repo,
        presence=presence,
        broker=broker,
        hub=SignalingHub(broker),
        rooms=RoomService(repo, settings, presence),
        events=events,
        room_limiter=KeyedRateLimiter(capacity=per_minute, rate=per_minute / 60),
        checks=checks,
        closers=closers,
    )
