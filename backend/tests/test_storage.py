# tests/test_storage.py

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import create_async_engine

from kolo.db.session import make_session_factory
from kolo.db.tables import Base
from kolo.domain.errors import RoomCodeTaken
from kolo.domain.models import Room
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
    # spin up a quick in-memory sqlite db just for testing
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        
    yield SqlRoomRepository(make_session_factory(engine))
    await engine.dispose()

async def test_sql_repo_roundtrip(sql_repo):
    room = make_room()
    await sql_repo.add(room)
    
    # make sure it actually saved and we can fetch it back
    assert await sql_repo.get_by_code(room.code) == room
    # bogus codes should just return None
    assert await sql_repo.get_by_code("zzz-zzzz-zzz") is None

async def test_sql_repo_unique_code(sql_repo):
    await sql_repo.add(make_room())
    
    # db should blow up if we try to reuse a room code
    with pytest.raises(RoomCodeTaken):
        await sql_repo.add(make_room())