# src/kolo/repositories/sql.py

from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker

from kolo.db.tables import RoomRow
from kolo.domain.errors import RoomCodeTaken
from kolo.domain.models import Room


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)

def _to_domain(row: RoomRow) -> Room:
    return Room(
        code=row.code,
        name=row.name,
        host_secret_hash=row.host_secret_hash,
        max_participants=row.max_participants,
        lobby_enabled=row.lobby_enabled,
        created_at=_aware(row.created_at),
        expires_at=_aware(row.expires_at),
    )

class SqlRoomRepository:
    def __init__(self, session_factory: async_sessionmaker) -> None:
        self._sessions = session_factory

    async def add(self, room: Room) -> None:
        async with self._sessions() as session:
            session.add(RoomRow(
                code=room.code,
                name=room.name,
                host_secret_hash=room.host_secret_hash,
                max_participants=room.max_participants,
                lobby_enabled=room.lobby_enabled,
                created_at=room.created_at,
                expires_at=room.expires_at,
            ))
            try:
                await session.commit()
            except IntegrityError as exc:  # UNIQUE(code)
                raise RoomCodeTaken() from exc

    async def get_by_code(self, code: str) -> Room | None:
        async with self._sessions() as session:
            row = await session.scalar(select(RoomRow).where(RoomRow.code == code))
            return _to_domain(row) if row else None

    async def delete_expired(self, older_than: datetime) -> int:
        async with self._sessions() as session:
            # Находим все строки, у которых срок годности меньше переданной даты
            stmt = delete(RoomRow).where(RoomRow.expires_at < older_than)
            result = await session.execute(stmt)
            await session.commit()
            return result.rowcount