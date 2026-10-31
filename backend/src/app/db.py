"""Database base and explicit async engine construction."""

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Protocol

from fastapi import Request
from sqlalchemy import event
from sqlalchemy.engine import URL
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlalchemy.orm import DeclarativeBase


class SQLiteCursor(Protocol):
    def execute(self, statement: str) -> object: ...

    def close(self) -> object: ...


class SQLiteConnection(Protocol):
    def cursor(self) -> SQLiteCursor: ...


class Base(DeclarativeBase):
    pass


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    """Supply one async session per request from the application's lifespan."""
    async with request.app.state.session_factory() as session:
        yield session


def create_engine(database_path: Path) -> AsyncEngine:
    """Create a WAL-enabled SQLite engine without opening it on import."""
    database_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    url = URL.create("sqlite+aiosqlite", database=str(database_path))
    engine = create_async_engine(url)

    @event.listens_for(engine.sync_engine, "connect")
    def enable_wal(dbapi_connection: SQLiteConnection, _connection_record: object) -> None:
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA foreign_keys=ON")
        finally:
            cursor.close()

    return engine
