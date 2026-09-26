"""An incremental conversation migration must preserve existing user records."""

import sqlite3
from pathlib import Path
from typing import Any

import pytest
from alembic.config import Config

from alembic import command


def insert(connection: sqlite3.Connection, table: str, values: dict[str, Any]) -> None:
    columns = ", ".join(values)
    placeholders = ", ".join("?" for _ in values)
    connection.execute(
        f"INSERT INTO {table} ({columns}) VALUES ({placeholders})", tuple(values.values())
    )


def test_chat_upgrade_preserves_old_configuration_and_verification(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "upgrade.db"
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    command.upgrade(config, "0003_model_identity")
    timestamp = "2026-09-26 00:00:00"
    source_id = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
    segment_id = "01ARZ3NDEKTSV4RRFFQ69G5FAW"
    run_id = "01ARZ3NDEKTSV4RRFFQ69G5FAX"
    with sqlite3.connect(database) as connection:
        insert(
            connection,
            "sources",
            {
                "id": source_id,
                "title": "保存済み",
                "description": "出典",
                "note": "管理メモ",
                "created_at": timestamp,
                "updated_at": timestamp,
            },
        )
        insert(
            connection,
            "segments",
            {
                "id": segment_id,
                "source_id": source_id,
                "text": "原文を保存する。",
                "translation": "译文",
                "context_before": "前",
                "context_after": "后",
                "transcription": "",
                "note": "备注",
                "source_ref": "第一章",
                "created_at": timestamp,
                "updated_at": timestamp,
            },
        )
        insert(
            connection,
            "runs",
            {
                "id": run_id,
                "provider_id": source_id,
                "provider_name": "旧Provider",
                "provider_revision": 1,
                "provider_model_id": segment_id,
                "model_revision": 1,
                "model_id": "old-model",
                "protocol": "responses",
                "stream": 1,
                "status": "succeeded",
                "output_text": "既存の応答",
                "usage": '{"total_tokens": 5}',
                "prompt_version": "v1",
                "prompt_text": "原验证提示",
                "base_url": "http://localhost:9999/v1",
                "raw_response": "{}",
                "created_at": timestamp,
                "started_at": timestamp,
                "finished_at": timestamp,
            },
        )
        before = {
            table: (
                tuple(row[1] for row in connection.execute(f"PRAGMA table_info({table})")),
                connection.execute(f"SELECT * FROM {table}").fetchall(),
            )
            for table in ("sources", "segments", "runs")
        }
    command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        for table, (columns, rows) in before.items():
            assert (
                connection.execute(f"SELECT {', '.join(columns)} FROM {table}").fetchall() == rows
            )
        assert connection.execute("SELECT revision, text_locked_at FROM segments").fetchone() == (
            1,
            None,
        )
        assert connection.execute(
            "SELECT purpose, job_id, messages, deleted_at FROM runs"
        ).fetchone() == ("verification", None, None, None)
        for table in ("chat_threads", "chat_jobs", "chat_messages"):
            assert connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 0
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
