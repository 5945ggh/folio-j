"""Exercise empty-database rebuilds and Alembic's temporary generation path."""

import shutil
import sqlite3
from pathlib import Path

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory

from alembic import command


def test_empty_database_rebuilds_current_schema(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "empty.db"
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    heads = set(ScriptDirectory.from_config(config).get_heads())
    command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        assert {
            row[0] for row in connection.execute("SELECT version_num FROM alembic_version")
        } == heads
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        tables = {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        assert {
            "alembic_version",
            "sources",
            "segments",
            "learner_profile",
            "explanation_styles",
            "settings_defaults",
            "providers",
            "provider_models",
            "runs",
            "chat_threads",
            "chat_messages",
            "chat_jobs",
            "analyses",
            "analysis_revisions",
            "analysis_sections",
            "materials",
            "reading_positions",
            "chapter_reading_positions",
            "material_usage",
            "material_covers",
        } <= tables
        for table, expected_columns in {
            "sources": {
                "id",
                "title",
                "description",
                "note",
                "created_at",
                "updated_at",
                "deleted_at",
            },
            "segments": {
                "id",
                "source_id",
                "text",
                "translation",
                "context_before",
                "context_after",
                "transcription",
                "note",
                "source_ref",
                "created_at",
                "updated_at",
                "text_locked_at",
                "deleted_at",
            },
        }.items():
            columns = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
            assert expected_columns <= columns, table
        index = connection.execute(
            "SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_chat_job_active'"
        ).fetchone()
        assert index is not None
        assert "waiting_review" in index[0]


def test_revision_generation_and_upgrade_in_temporary_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = Path(__file__).resolve().parents[1] / "alembic"
    scripts = tmp_path / "alembic"
    scripts.mkdir()
    (scripts / "versions").mkdir()
    for name in ("env.py", "script.py.mako"):
        shutil.copy2(source / name, scripts / name)

    monkeypatch.setattr("app.config.REPO_ROOT", tmp_path)
    config = Config()
    config.set_main_option("script_location", str(scripts))
    command.revision(config, message="temporary smoke", rev_id="smoke001")
    assert len(list((scripts / "versions").glob("smoke001_*.py"))) == 1

    command.upgrade(config, "head")
    database = tmp_path / "data" / "app.db"
    with sqlite3.connect(database) as connection:
        revision = connection.execute("SELECT version_num FROM alembic_version").fetchone()
    assert revision == ("smoke001",)
