# src/kolo/container.py

from dataclasses import dataclass, field
from typing import Any, Callable

from kolo.core.config import Settings
from kolo.db.session import make_engine, make_session_factory
from kolo.infra.broker import Broker, MemoryBroker
from kolo.infra.presence import MemoryPresence, PresenceStore
from kolo.infra.rate_limit import KeyedRateLimiter
from kolo.repositories.memory import InMemoryRoomRepository
from kolo.repositories.sql import SqlRoomRepository
from kolo.services.events import EventSink, NullEventSink
from kolo.services.rooms import RoomService
from kolo.services.signaling.hub import SignalingHub

@dataclass
class Container:
    settings: Settings
    rooms: RoomService
    room_limiter: KeyedRateLimiter  # prevents IP spam for room creation
    presence: PresenceStore  # who is in which room right now
    broker: Broker  # pub/sub between sessions
    hub: SignalingHub  # routes messages to local WebSocket sessions
    events: EventSink  # analytics/audit events
    # keep track of cleanup stuff (like closing db connections)
    closers: list[Callable[[], Any]] = field(default_factory=list)

    async def aclose(self) -> None:
        # run all cleanups when the server stops so we don't leak resources
        for closer in self.closers:
            await closer()

async def build_container(settings: Settings) -> Container:
    closers = []
    
    # use fake in-memory db if set in config (handy for quick tests)
    if settings.database_url.startswith("memory"):
        repo = InMemoryRoomRepository()
    else:
        # otherwise hook up the real postgres db
        engine = make_engine(settings.database_url)
        repo = SqlRoomRepository(make_session_factory(engine))
        # remember to kill the db engine later
        closers.append(engine.dispose)
        
    # set up rate limiting: bucket size = max per min, refill rate = drops per sec
    limiter = KeyedRateLimiter(
        capacity=settings.rooms_per_minute_per_ip,
        rate=settings.rooms_per_minute_per_ip / 60
    )
        
    presence = MemoryPresence(ttl_seconds=settings.presence_ttl_seconds)
    broker = MemoryBroker()

    return Container(
        settings=settings, 
        rooms=RoomService(repo, settings, presence),
        room_limiter=limiter,
        presence=presence,
        broker=broker,
        hub=SignalingHub(broker),
        events=NullEventSink(),
        closers=closers
    )
