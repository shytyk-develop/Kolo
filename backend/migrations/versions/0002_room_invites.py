"""room invites

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-12 12:00:00

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | Sequence[str] | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "room_invites",
        sa.Column("invite_id", sa.String(length=36), nullable=False),
        sa.Column("room_code", sa.String(length=12), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("invite_id"),
    )
    op.create_index(op.f("ix_room_invites_room_code"), "room_invites", ["room_code"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_room_invites_room_code"), table_name="room_invites")
    op.drop_table("room_invites")
