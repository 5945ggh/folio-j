"""Alembic async migration environment."""

import asyncio

from sqlalchemy import Connection

from alembic import context
from app import analysis_models as _analysis_models
from app import chat_models as _chat_models
from app import material_models as _material_models
from app import models as _models
from app import settings_models as _settings_models
from app.config import load_settings
from app.db import create_engine

_ = (_analysis_models, _chat_models, _settings_models, _material_models)

target_metadata = _models.Base.metadata


def do_run_migrations(connection: Connection) -> None:
    # Rebuilding referenced SQLite tables requires FK checks to be suspended on
    # this dedicated connection, outside the migration transaction. Validate all
    # retained relationships before committing; normal application engines keep FK ON.
    connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
    connection.commit()
    try:
        with connection.begin():
            # sqlite3 otherwise delays BEGIN until DML, leaving earlier DDL
            # outside the rollback boundary even with transactional_ddl=True.
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            context.configure(
                connection=connection, target_metadata=target_metadata, transactional_ddl=True
            )
            with context.begin_transaction():
                context.run_migrations()
                if connection.exec_driver_sql("PRAGMA foreign_key_check").first() is not None:
                    raise RuntimeError("迁移后的外键校验失败，已回滚迁移")
    finally:
        connection.rollback()
        connection.exec_driver_sql("PRAGMA foreign_keys=ON")
        connection.commit()


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
