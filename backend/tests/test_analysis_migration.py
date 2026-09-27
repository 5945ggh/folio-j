"""The incremental Analysis migration preserves prior reading and chat data."""

import sqlite3
from pathlib import Path

import pytest
from alembic.config import Config

from alembic import command


def test_analysis_upgrade_preserves_existing_segment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "upgrade.db"
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    command.upgrade(config, "0004_chat_jobs")
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
    command.upgrade(config, "0005_analyses")
    with sqlite3.connect(database) as connection:
        actual = connection.execute(
            "SELECT text FROM segments WHERE id=?", (segment_id,)
        ).fetchone()
        assert actual == ("旧原文",)
        for table in ("analyses", "analysis_revisions", "analysis_sections"):
            assert connection.execute(f"SELECT count(*) FROM {table}").fetchone() == (0,)
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
