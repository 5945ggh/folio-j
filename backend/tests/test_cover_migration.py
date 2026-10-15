"""Cover rule upgrades preserve old success/failure caches and immutable book data."""

import sqlite3
from pathlib import Path

import pytest
from alembic.config import Config

from alembic import command


def test_cover_rule_upgrade_preserves_existing_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "upgrade.db"
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    command.upgrade(config, "0008_material_usage")
    stamp = "2026-10-04 00:00:00"
    with sqlite3.connect(database) as connection:
        connection.execute(
            "INSERT INTO sources(id,title,description,note,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?)",
            ("source", "迁移", "", "", stamp, stamp),
        )
        for mid, image in [("success", b"cached"), ("failure", None)]:
            connection.execute(
                "INSERT INTO materials(id,source_id,title,source_sha256,version_id,product_sha256,"
                "contract_version,original_bytes,warnings,compiled_bundle,created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (mid, "source", mid, mid, mid, "hash", "test", b"original", "[]", b"bundle", stamp),
            )
            connection.execute(
                "INSERT INTO material_covers VALUES (?,?,?)",
                (mid, "image/png" if image else None, image),
            )
        before = connection.execute("SELECT * FROM materials ORDER BY id").fetchall()
        covers = connection.execute("SELECT * FROM material_covers ORDER BY material_id").fetchall()
    command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT * FROM materials ORDER BY id").fetchall() == before
        rows = connection.execute("SELECT * FROM material_covers ORDER BY material_id").fetchall()
        assert [row[:3] for row in rows] == covers
        assert [row[3:] for row in rows] == [(1, "legacy_cache")] * 2
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
