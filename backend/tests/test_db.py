import os
from pathlib import Path

import pytest
from sqlalchemy import text

from app.db import create_engine


@pytest.mark.asyncio
async def test_sqlite_handles_special_filename_and_enables_connection_pragmas(
    tmp_path: Path,
) -> None:
    # Windows forbids '?'; '#' and '%' still exercise SQLAlchemy URL escaping.
    filename = "app # % test.db" if os.name == "nt" else "app ?# % test.db"
    database_path = tmp_path / filename
    engine = create_engine(database_path)
    try:
        async with engine.connect() as connection:
            journal_mode = await connection.scalar(text("PRAGMA journal_mode"))
            foreign_keys = await connection.scalar(text("PRAGMA foreign_keys"))
        assert journal_mode == "wal"
        assert foreign_keys == 1
        assert database_path.is_file()
    finally:
        await engine.dispose()
