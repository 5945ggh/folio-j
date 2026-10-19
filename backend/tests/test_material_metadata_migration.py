"""Upgrade populated 0011 databases without rewriting book or reading records."""

import sqlite3
from pathlib import Path

import pytest
from alembic.config import Config

from alembic import command


def test_metadata_upgrade_and_downgrade_preserve_existing_materials(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "metadata-upgrade.db"
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    command.upgrade(config, "0011_chapter_positions")
    stamp = "2026-10-19 00:00:00"
    with sqlite3.connect(database) as connection:
        connection.execute(
            "INSERT INTO sources(id,title,description,note,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?)",
            ("source", "来源", "", "", stamp, stamp),
        )
        connection.execute(
            "INSERT INTO materials VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                "book",
                "source",
                "原书",
                "digest",
                "version",
                "product",
                "test",
                b"original",
                "[]",
                b"compiled",
                stamp,
            ),
        )
        connection.execute(
            "INSERT INTO reading_positions VALUES (?,?,?,?)", ("book", 3, "{}", stamp)
        )
        connection.execute(
            "INSERT INTO chapter_reading_positions VALUES (?,?,?,?,?)",
            (
                "book",
                "chapter",
                3,
                "{}",
                stamp,
            ),
        )
        connection.execute(
            "INSERT INTO material_usage VALUES (?,?,?,?,?,?)",
            (
                "book",
                "completed",
                5,
                stamp,
                "last-action",
                stamp,
            ),
        )
        connection.execute(
            "INSERT INTO material_covers VALUES (?,?,?,?,?)",
            (
                "book",
                "image/png",
                b"cached",
                2,
                "declared",
            ),
        )
        before = connection.execute("SELECT * FROM materials").fetchall()
        tables = (
            "sources",
            "reading_positions",
            "chapter_reading_positions",
            "material_usage",
            "material_covers",
        )
        snapshots = {
            table: connection.execute(f"SELECT * FROM {table}").fetchall() for table in tables
        }
    command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        rows = connection.execute("SELECT * FROM materials").fetchall()
        assert [row[:-1] for row in rows] == before
        assert [row[-1] for row in rows] == [0]
        assert connection.execute("SELECT * FROM material_custom_covers").fetchall() == []
        assert {
            table: connection.execute(f"SELECT * FROM {table}").fetchall() for table in tables
        } == snapshots
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        connection.execute(
            "INSERT INTO material_custom_covers VALUES (?,?,?)", ("book", "image/jpeg", b"custom")
        )
    command.downgrade(config, "0011_chapter_positions")
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT * FROM materials").fetchall() == before
        assert {
            table: connection.execute(f"SELECT * FROM {table}").fetchall() for table in tables
        } == snapshots
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    command.upgrade(config, "head")
