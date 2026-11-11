# tests/test_storage.py

from datetime import UTC, datetime, timedelta

import fakeredis
import pytest
from sqlalchemy.ext.asyncio import create_async_engine

from kolo.db.session import make_session_factory
from kolo.db.tables import Base
from kolo.domain.errors import RoomCodeTaken
from kolo.domain.models import Peer, Role, Room
from kolo.infra.broker import RedisBroker
from kolo.infra.presence import MemoryPresence, RedisPresence
from kolo.repositories.sql import SqlRoomRepository


def make_room(code: str = "abc-defg-hij") -> Room:
    now = datetime.now(UTC)
    return Room(
        code=code, 
        name="Test", 
        host_secret_hash="0" * 64, 
        max_participants=2, 
        lobby_enabled=False, 
        created_at=now, 
        expires_at=now + timedelta(hours=1)
    )

@pytest.fixture
async def sql_repo():
    # in-memory sqlite
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        
    yield SqlRoomRepository(make_session_factory(engine))
    await engine.dispose()

async def test_sql_repo_roundtrip(sql_repo):
    room = make_room()
    await sql_repo.add(room)
    
    # saved and read back
    assert await sql_repo.get_by_code(room.code) == room
    # unknown code -> None
    assert await sql_repo.get_by_code("zzz-zzzz-zzz") is None

async def test_sql_repo_set_lobby(sql_repo):
    await sql_repo.add(make_room())

    updated = await sql_repo.set_lobby("abc-defg-hij", True)
    assert updated is not None and updated.lobby_enabled is True
    assert (await sql_repo.get_by_code("abc-defg-hij")).lobby_enabled is True
    # unknown code -> None, nothing created
    assert await sql_repo.set_lobby("zzz-zzzz-zzz", True) is None


async def test_sql_repo_unique_code(sql_repo):
    await sql_repo.add(make_room())
    
    # same code twice fails
    with pytest.raises(RoomCodeTaken):
        await sql_repo.add(make_room())


# ---------- one test, two implementations ----------


@pytest.fixture(params=["memory", "redis"])
def presence_factory(request):
    def make(clock):
        if request.param == "memory":
            return MemoryPresence(ttl_seconds=60, clock=clock)
        redis = fakeredis.FakeAsyncRedis(decode_responses=True)
        return RedisPresence(redis, ttl_seconds=60, clock=clock)

    return make


async def test_presence_expires_silent_peers(presence_factory):
    now = [1000.0]
    presence = presence_factory(lambda: now[0])
    a, b = Peer("p_a", "A", Role.HOST), Peer("p_b", "B", Role.GUEST)

    assert await presence.add("r", a) == 1
    now[0] += 30
    assert await presence.add("r", b) == 2
    now[0] += 40  # A has been silent for 70 seconds, B for 40
    assert [p.id for p in await presence.members("r")] == ["p_b"]

    await presence.touch("r", "p_b")
    await presence.remove("r", "p_b")
    assert await presence.count("r") == 0


async def test_redis_broker_pubsub():
    broker = RedisBroker(fakeredis.FakeAsyncRedis(decode_responses=True))
    async with broker.subscribe("kolo:room:x") as messages:
        await broker.publish("kolo:room:x", {"hello": "world"})
        assert await anext(messages) == {"hello": "world"}
