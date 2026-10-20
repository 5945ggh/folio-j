"""Exercise empty-database rebuilds and Alembic's temporary generation path."""

import logging
import shutil
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import pytest
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import URL, create_engine

from alembic import command
from app import analysis_models, chat_models, material_models, models, settings_models
from app.db import Base

_ = (analysis_models, chat_models, material_models, models, settings_models)


def test_empty_database_rebuilds_current_schema(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "empty.db"
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    scripts = ScriptDirectory.from_config(config)
    revisions = list(scripts.walk_revisions())
    assert len(scripts.get_bases()) == len(scripts.get_heads()) == 1
    assert revisions[-1].down_revision is None
    assert scripts.get_bases() == [revisions[-1].revision]
    assert scripts.get_heads() == [revisions[0].revision]
    assert all(
        newer.down_revision == older.revision
        for newer, older in zip(revisions, revisions[1:], strict=False)
    )
    heads = set(scripts.get_heads())
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
        assert len(Base.metadata.tables) == 22
        assert tables == {"alembic_version", *Base.metadata.tables}

    # Compare every column, type, nullable flag, foreign key, index and uniqueness
    # rule. Historical SQL defaults intentionally differ from ORM insert defaults.
    engine = create_engine(URL.create("sqlite", database=str(database)))
    try:
        with engine.connect() as connection:
            context = MigrationContext.configure(
                connection, opts={"compare_type": True, "compare_server_default": False}
            )
            assert compare_metadata(context, Base.metadata) == []
    finally:
        engine.dispose()

    command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert {
            row[0] for row in connection.execute("SELECT version_num FROM alembic_version")
        } == heads


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


def test_legacy_analysis_protection_preserves_current_text_and_all_history(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    database = tmp_path / "preserved.db"
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    command.upgrade(config, "0001_initial")
    historical = "2020-01-02 03:04:05.123456"
    existing_lock = "2021-03-04 05:06:07.123456"
    cases = (
        ("already_locked", existing_lock, None, False),
        ("unlocked_analysis", None, None, False),
        ("only_deleted_analysis", None, None, True),
        ("without_analysis", None, None, False),
        ("deleted_segment", None, historical, False),
        ("deleted_both", None, historical, True),
    )
    with sqlite3.connect(database) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute(
            """
            INSERT INTO sources (id, title, description, note, created_at, updated_at)
            VALUES ('source', '原文保護', '説明', 'メモ', ?, ?)
            """,
            (historical, historical),
        )
        for segment_id, locked_at, deleted_at, deleted_analysis in cases:
            connection.execute(
                """
                INSERT INTO segments
                    (id, source_id, text, translation, context_before, context_after,
                     transcription, note, source_ref, created_at, updated_at,
                     revision, text_locked_at, deleted_at)
                VALUES (?, 'source', ?, '訳文', '前文', '後文', '聴取', '備考',
                        '自由出典', ?, ?, 7, ?, ?)
                """,
                (
                    segment_id,
                    f"現在の原文：{segment_id}𠮷",
                    historical,
                    historical,
                    locked_at,
                    deleted_at,
                ),
            )
            if segment_id == "without_analysis":
                continue
            analysis_id = f"a-{segment_id}"
            connection.execute(
                """
                INSERT INTO analyses
                    (id, segment_id, operation_key, title, excerpt, current_revision_id,
                     created_at, updated_at, deleted_at)
                VALUES (?, ?, ?, '講解', '抜粋', ?, ?, ?, ?)
                """,
                (
                    analysis_id,
                    segment_id,
                    analysis_id,
                    f"{analysis_id}-r2",
                    historical,
                    historical,
                    historical if deleted_analysis else None,
                ),
            )
            for number in (1, 2):
                revision_id = f"{analysis_id}-r{number}"
                connection.execute(
                    """
                    INSERT INTO analysis_revisions
                        (id, analysis_id, parent_revision_id, operation_key, operation_payload,
                         origin, run_id, source_md, normalizer_version, warnings, created_at)
                    VALUES (?, ?, ?, ?, '{"old": true}', 'agent', NULL, ?, 1, '["旧警告"]', ?)
                    """,
                    (
                        revision_id,
                        analysis_id,
                        f"{analysis_id}-r1" if number == 2 else None,
                        revision_id,
                        f"## 過去の講解 {number}\n現在の原文から復元しない。\n",
                        historical,
                    ),
                )
                connection.execute(
                    """
                    INSERT INTO analysis_sections
                        (id, revision_id, uid, handle, kind, display_no, title,
                         start_line, end_line, raw, ordinal)
                    VALUES (?, ?, ?, 's1', 'section', '1', '旧ブロック', 0, 2, ?, 1)
                    """,
                    (
                        f"{revision_id}-section",
                        revision_id,
                        f"{revision_id}-uid",
                        f"## 過去の講解 {number}\n現在の原文から復元しない。\n",
                    ),
                )
        connection.commit()
        content_before = _segment_content(connection)
        history_before = _historical_content(connection)
    started = datetime.now(UTC)
    with caplog.at_level(logging.INFO, logger="alembic.runtime.migration"):
        command.upgrade(config, "head")
    finished = datetime.now(UTC)
    assert any(
        "已为 4 个存在历史讲解的片段固定当前原文" in record.message for record in caplog.records
    )
    with sqlite3.connect(database) as connection:
        locks = dict(connection.execute("SELECT id,text_locked_at FROM segments"))
        assert locks["already_locked"] == existing_lock
        assert locks["without_analysis"] is None
        protected = {
            "unlocked_analysis",
            "only_deleted_analysis",
            "deleted_segment",
            "deleted_both",
        }
        assert len({locks[segment_id] for segment_id in protected}) == 1
        for segment_id in protected:
            recorded = datetime.fromisoformat(locks[segment_id])
            recorded = recorded.replace(tzinfo=UTC) if recorded.tzinfo is None else recorded
            assert started <= recorded <= finished
        assert _segment_content(connection) == content_before
        assert _historical_content(connection) == history_before
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    # A second upgrade is a no-op, including all recorded protection times.
    command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        assert dict(connection.execute("SELECT id,text_locked_at FROM segments")) == locks
        assert _segment_content(connection) == content_before
        assert _historical_content(connection) == history_before
        # Simulate a later AI acceptance lock on the previously free segment.
        later_lock = datetime.now(UTC).isoformat()
        connection.execute(
            "UPDATE segments SET text_locked_at=? WHERE id='without_analysis'", (later_lock,)
        )
        connection.commit()
        locks["without_analysis"] = later_lock
    command.downgrade(config, "0001_initial")
    with sqlite3.connect(database) as connection:
        assert dict(connection.execute("SELECT id,text_locked_at FROM segments")) == locks
        assert _segment_content(connection) == content_before
        assert _historical_content(connection) == history_before
        assert connection.execute("SELECT version_num FROM alembic_version").fetchone() == (
            "0001_initial",
        )
    # Reapplying the backfill cannot rewrite either migrated or later locks.
    command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        assert dict(connection.execute("SELECT id,text_locked_at FROM segments")) == locks
        assert _segment_content(connection) == content_before
        assert _historical_content(connection) == history_before
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)


def _segment_content(connection: sqlite3.Connection) -> list[tuple[object, ...]]:
    return connection.execute(
        """
        SELECT id, source_id, text, translation, context_before, context_after,
               transcription, note, source_ref, created_at, updated_at, revision, deleted_at
        FROM segments ORDER BY id
        """
    ).fetchall()


def _historical_content(connection: sqlite3.Connection) -> dict[str, list[tuple[object, ...]]]:
    return {
        table: connection.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()
        for table in ("sources", "analyses", "analysis_revisions", "analysis_sections")
    }
