# src/kolo/repositories/sql.py

from datetime import UTC, datetime

from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker

from kolo.db.tables import RoomInviteRow, RoomRow
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

    async def set_lobby(self, code: str, enabled: bool) -> Room | None:
        async with self._sessions() as session:
            await session.execute(update(RoomRow).where(RoomRow.code == code).values(lobby_enabled=enabled))
            await session.commit()
            row = await session.scalar(select(RoomRow).where(RoomRow.code == code))
            return _to_domain(row) if row else None

    async def delete_expired(self, older_than: datetime) -> int:
        async with self._sessions() as session:
            # rows that expired before older_than
            stmt = delete(RoomRow).where(RoomRow.expires_at < older_than)
            result = await session.execute(stmt)
            await session.commit()
            return result.rowcount
    async def add_invite(self, code: str, invite_id: str) -> None:
        async with self._sessions() as session:
            session.add(RoomInviteRow(invite_id=invite_id, room_code=code, created_at=datetime.now(UTC)))
            await session.commit()

    async def take_invites(self, code: str) -> list[str]:
        return await self._take(RoomInviteRow.room_code == code)

    async def take_expired_invites(self, now: datetime) -> list[str]:
        live = select(RoomRow.code).where(RoomRow.expires_at > now)
        return await self._take(RoomInviteRow.room_code.not_in(live))

    async def _take(self, where) -> list[str]:
        async with self._sessions() as session:
            ids = list(await session.scalars(select(RoomInviteRow.invite_id).where(where)))
            if ids:
                await session.execute(delete(RoomInviteRow).where(RoomInviteRow.invite_id.in_(ids)))
                await session.commit()
            return ids
