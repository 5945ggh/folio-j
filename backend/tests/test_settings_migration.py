"""The settings migration must preserve previously saved reading material."""

import sqlite3
from pathlib import Path

import pytest
from alembic.config import Config

from alembic import command


def migration_config(database: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    return config


def insert_provider_and_model(database: Path, *, duplicate: bool = False) -> tuple[str, str]:
    provider_id = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
    model_id = "01ARZ3NDEKTSV4RRFFQ69G5FAW"
    timestamp = "2026-01-01 00:00:00"
    with sqlite3.connect(database) as connection:
        connection.execute(
            "INSERT INTO providers "
            "(id, name, base_url, protocol, enabled, discovered_models, discovery_status, "
            "revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                provider_id,
                "已有模型服务",
                "http://localhost:8765/v1",
                "chat_completions",
                1,
                "[]",
                "never",
                1,
                timestamp,
                timestamp,
            ),
        )
        connection.execute(
            "INSERT INTO provider_models "
            "(id, provider_id, model_id, enabled, revision, text_status, stream_status) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (model_id, provider_id, "upstream-model", 1, 1, "unknown", "unknown"),
        )
        if duplicate:
            connection.execute(
                "INSERT INTO provider_models "
                "(id, provider_id, model_id, enabled, revision, text_status, stream_status) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    "01ARZ3NDEKTSV4RRFFQ69G5FAX",
                    provider_id,
                    "upstream-model",
                    1,
                    1,
                    "unknown",
                    "unknown",
                ),
            )
    return provider_id, model_id


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


def test_model_identity_migration_preserves_existing_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "migration.db"
    config = migration_config(database, monkeypatch)
    command.upgrade(config, "0002_settings")
    provider_id, model_id = insert_provider_and_model(database)

    command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        provider = connection.execute(
            "SELECT name FROM providers WHERE id = ?", (provider_id,)
        ).fetchone()
        model = connection.execute(
            "SELECT model_id FROM provider_models WHERE id = ?", (model_id,)
        ).fetchone()
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO provider_models "
                "(id, provider_id, model_id, enabled, revision, text_status, stream_status) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    "01ARZ3NDEKTSV4RRFFQ69G5FAX",
                    provider_id,
                    "upstream-model",
                    1,
                    1,
                    "unknown",
                    "unknown",
                ),
            )
    assert provider == ("已有模型服务",)
    assert model == ("upstream-model",)


def test_model_identity_migration_rejects_existing_duplicates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "migration.db"
    config = migration_config(database, monkeypatch)
    command.upgrade(config, "0002_settings")
    provider_id, _model_id = insert_provider_and_model(database, duplicate=True)

    with pytest.raises(RuntimeError, match="存在重复模型登记"):
        command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        count = connection.execute(
            "SELECT count(*) FROM provider_models WHERE provider_id = ? AND model_id = ?",
            (provider_id, "upstream-model"),
        ).fetchone()
    assert count == (2,)
