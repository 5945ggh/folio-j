"""Material migration preserves existing learning data."""

import sqlite3
from pathlib import Path

import pytest
from alembic.config import Config

from alembic import command


def test_material_upgrade_preserves_existing_segment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "upgrade.db"
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    command.upgrade(config, "0006_analysis_execution")
    source_id = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
    segment_id = "01ARZ3NDEKTSV4RRFFQ69G5FAW"
    stamp = "2026-09-26 00:00:00"
    with sqlite3.connect(database) as connection:
        connection.execute(
            "INSERT INTO sources (id,title,description,note,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?)",
            (source_id, "旧资料", "", "", stamp, stamp),
        )
        connection.execute(
            "INSERT INTO segments (id,source_id,text,translation,context_before,context_after,"
            "transcription,note,source_ref,created_at,updated_at,revision) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (segment_id, source_id, "旧原文", "", "", "", "", "", "", stamp, stamp, 1),
        )
    command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        actual = connection.execute(
            "SELECT text FROM segments WHERE id=?", (segment_id,)
        ).fetchone()
        assert actual == ("旧原文",)
        for table in ("materials", "reading_positions"):
            assert connection.execute(f"SELECT count(*) FROM {table}").fetchone() == (0,)
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


def test_usage_upgrade_validates_positions_and_preserves_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import json
    import zlib

    from test_materials import compiled

    database = tmp_path / "old-books.db"
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    command.upgrade(config, "0007_materials")
    stamp = "2026-09-26 00:00:00"
    book = zlib.compress(compiled(b"").model_dump_json().encode())
    source = "source"
    with sqlite3.connect(database) as connection:
        connection.execute(
            "INSERT INTO sources(id,title,description,note,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?)",
            (source, "旧书", "原描述", "", stamp, stamp),
        )
        for i in range(4):
            mid = str(i)
            connection.execute(
                "INSERT INTO materials(id,source_id,title,source_sha256,version_id,"
                "product_sha256,contract_version,original_bytes,warnings,compiled_bundle,"
                "created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    mid,
                    source,
                    "旧书" + mid,
                    mid,
                    "version" + mid,
                    "hash",
                    "test",
                    b"original" + mid.encode(),
                    "[]",
                    book,
                    stamp,
                ),
            )
            if i < 3:
                payload = {
                    "version_id": "version" + mid,
                    "chapter_id": "c1",
                    "part_index": 0,
                    "resource_id": "r1",
                    "kind": "text",
                    "offset": 2,
                }
                if i == 1:
                    payload["version_id"] = "stale"
                if i == 2:
                    payload["resource_id"] = "foreign"
                connection.execute(
                    "INSERT INTO reading_positions(material_id,revision,payload,updated_at) "
                    "VALUES (?,1,?,?)",
                    (mid, json.dumps(payload), stamp),
                )
        before = connection.execute("SELECT * FROM materials ORDER BY id").fetchall()
        positions = connection.execute(
            "SELECT * FROM reading_positions ORDER BY material_id"
        ).fetchall()
    command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT * FROM materials ORDER BY id").fetchall() == before
        assert (
            connection.execute("SELECT * FROM reading_positions ORDER BY material_id").fetchall()
            == positions
        )
        rows = connection.execute(
            "SELECT status,revision,last_opened_at,last_action_id "
            "FROM material_usage ORDER BY material_id"
        ).fetchall()
        assert rows == [("in_progress", 0, None, None)] + [("not_started", 0, None, None)] * 3
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
