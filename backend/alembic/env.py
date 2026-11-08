"""Alembic async migration environment."""

import asyncio
import sys
from pathlib import Path

from sqlalchemy import Connection

from alembic import context
from app import analysis_models as _analysis_models
from app import chat_models as _chat_models
from app import context_copy_models as _context_copy_models
from app import material_models as _material_models
from app import models as _models
from app import segment_context_models as _segment_context_models
from app import settings_models as _settings_models
from app import translation_models as _translation_models
from app.config import load_settings
from app.db import create_engine

_ = (
    _translation_models,
    _analysis_models,
    _chat_models,
    _settings_models,
    _material_models,
    _segment_context_models,
    _context_copy_models,
)

target_metadata = _models.Base.metadata


def do_run_migrations(connection: Connection) -> None:
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


async def run_migrations_online() -> None:
    # The production launcher validates the path before taking the worker lock.
    # Reloading settings afterwards would mistake a fresh empty database's lock
    # for an orphan companion; the normal Alembic CLI still resolves settings here.
    database_path = context.config.attributes.get("database_path")
    if database_path is None:
        database_path = load_settings().database.path
    if not isinstance(database_path, Path):
        raise ValueError("迁移数据库路径必须是已校验的 Path")
    print(f"迁移使用的数据库：{database_path}", file=sys.stderr, flush=True)
    engine = create_engine(database_path)
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
