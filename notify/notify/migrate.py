from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from .config import load_dotenv
from .store import connect

MIGRATIONS = Path(__file__).resolve().parent.parent / "migrations"
# any constant: parallel runs wait for each other
LOCK_ID = 73_665_110


async def migrate(url: str, directory: Path = MIGRATIONS) -> list[str]:
    # one transaction: a broken file applies nothing
    files = sorted(directory.glob("*.sql"))  # noqa: ASYNC240
    conn = await connect(url)
    try:
        async with conn.transaction():
            await conn.execute("select pg_advisory_xact_lock($1)", LOCK_ID)
            await conn.execute(
                "create table if not exists schema_migrations"
                " (version text primary key, applied_at timestamptz not null default now())"
            )
            done = {row["version"] for row in await conn.fetch("select version from schema_migrations")}
            applied = []
            for path in files:
                if path.stem in done:
                    continue
                await conn.execute(path.read_text())
                await conn.execute("insert into schema_migrations (version) values ($1)", path.stem)
                applied.append(path.stem)
            return applied
    finally:
        await conn.close()


def main() -> None:
    load_dotenv()
    url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        sys.exit("DATABASE_URL is not set")
    applied = asyncio.run(migrate(url))
    print("applied: " + ", ".join(applied) if applied else "up to date")


if __name__ == "__main__":
    main()
