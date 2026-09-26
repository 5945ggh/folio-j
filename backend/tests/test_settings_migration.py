"""The settings migration must preserve previously saved reading material."""

import sqlite3
from pathlib import Path

import pytest
from alembic.config import Config

from alembic import command


def test_settings_upgrade_preserves_source_and_segment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "migration.db"
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    command.upgrade(config, "0001_source_segment")

    source_id = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
    segment_id = "01ARZ3NDEKTSV4RRFFQ69G5FAW"
    timestamp = "2026-01-01 00:00:00"
    with sqlite3.connect(database) as connection:
        connection.execute(
            "INSERT INTO sources (id, title, description, note, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (source_id, "既存資料", "出典", "保存する", timestamp, timestamp),
        )
        connection.execute(
            "INSERT INTO segments "
            "(id, source_id, text, translation, context_before, context_after, "
            "transcription, note, source_ref, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                segment_id,
                source_id,
                "昨日は雨だった。",
                "昨天下雨了。",
                "",
                "",
                "",
                "旧记录",
                "第一章",
                timestamp,
                timestamp,
            ),
        )

    command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        source = connection.execute(
            "SELECT title, description, note FROM sources WHERE id = ?", (source_id,)
        ).fetchone()
        segment = connection.execute(
            "SELECT source_id, text, translation, note, source_ref FROM segments WHERE id = ?",
            (segment_id,),
        ).fetchone()
    assert source == ("既存資料", "出典", "保存する")
    assert segment == (source_id, "昨日は雨だった。", "昨天下雨了。", "旧记录", "第一章")
