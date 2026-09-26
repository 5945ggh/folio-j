"""Alembic async migration environment."""

import asyncio

from sqlalchemy import Connection

from alembic import context
from app.config import load_settings
from app.db import Base, create_engine

target_metadata = Base.metadata


def do_run_migrations(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    settings = load_settings()
    engine = create_engine(settings.database.path)
    try:
        async with engine.connect() as connection:
            await connection.run_sync(do_run_migrations)
    finally:
        await engine.dispose()


def run_migrations_offline() -> None:
    raise RuntimeError("Offline SQL migration generation is not configured")


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
