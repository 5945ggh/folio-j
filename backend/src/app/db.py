"""Database base and explicit async engine construction."""

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Protocol

from fastapi import Request
from sqlalchemy import event
from sqlalchemy.engine import URL
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.platform_io import make_private_directory


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


def sqlite_file_uri(uri: str) -> str:
    """Adapt a Path.as_uri() filename for SQLite, including Windows UNC shares."""
    if not uri.startswith("file:///"):
        # SQLite builds can reject a non-local URI authority. Keep the server
        # and share in the filename by using an empty authority and a UNC path.
        uri = "file:////" + uri.removeprefix("file://")
    return uri


def create_engine(database_path: Path, *, require_existing: bool = False) -> AsyncEngine:
    """Create a WAL-enabled SQLite engine without opening it on import."""
    if require_existing:
        url = URL.create(
            "sqlite+aiosqlite",
            database=sqlite_file_uri(database_path.absolute().as_uri()),
            query={"mode": "rw", "uri": "true"},
        )
    else:
        make_private_directory(database_path.parent, parents=True, exist_ok=True)
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
