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
from app import (
    analysis_models,
    chat_models,
    material_models,
    models,
    segment_context_models,
    settings_models,
)
from app.db import Base

_ = (analysis_models, chat_models, material_models, models, settings_models, segment_context_models)


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


def test_material_migration_retains_referenced_rows_and_refuses_lossy_downgrade(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "materials.db"
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    command.upgrade(config, "0002_lock_analysis_segments")
    with sqlite3.connect(database) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute(
            "INSERT INTO sources (id,title,description,note,created_at,updated_at) "
            "VALUES ('source','本','','','2020-01-01','2020-01-01')"
        )
        connection.execute(
            "INSERT INTO materials (id,source_id,title,source_sha256,version_id,product_sha256,"
            "contract_version,original_bytes,warnings,compiled_bundle,created_at) "
            "VALUES ('material','source','本','digest','version','product','v1',?, "
            "'[]',?, '2020-01-01')",
            (b"original", b"compiled"),
        )
        for table, columns, values in (
            (
                "reading_positions",
                "material_id,revision,payload,updated_at",
                "'material',7,'{}','2020-01-01'",
            ),
            (
                "chapter_reading_positions",
                "material_id,chapter_id,revision,payload,updated_at",
                "'material','chapter',7,'{}','2020-01-01'",
            ),
            (
                "material_usage",
                "material_id,status,revision,updated_at",
                "'material','completed',3,'2020-01-01'",
            ),
            ("material_covers", "material_id,media_type,data", "'material','image/png',X'1234'"),
            (
                "material_custom_covers",
                "material_id,media_type,data",
                "'material','image/png',X'5678'",
            ),
            (
                "material_readings_generations",
                "id,material_id,version_id,asset_sha256,configuration,token_count,payload,created_at",
                "'generation','material','version','asset','config',1,X'1234','2020-01-01'",
            ),
            ("material_readings_current", "material_id,generation_id", "'material','generation'"),
        ):
            connection.execute(f"INSERT INTO {table} ({columns}) VALUES ({values})")
        connection.commit()
        columns = [row[1] for row in connection.execute("PRAGMA table_info(materials)")]
        original = connection.execute("SELECT * FROM materials").fetchall()
        dependencies = {
            table: connection.execute(f"SELECT * FROM {table}").fetchall()
            for (table,) in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN "
                "('materials', 'alembic_version')"
            )
        }
    command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        assert (
            connection.execute(f"SELECT {','.join(columns)} FROM materials").fetchall() == original
        )
        assert connection.execute("SELECT deleted_at FROM materials").fetchall() == [(None,)]
        for table, rows in dependencies.items():
            assert connection.execute(f"SELECT * FROM {table}").fetchall() == rows
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    # Safe rollback and re-upgrade also preserve every dependent row.
    command.downgrade(config, "0002_lock_analysis_segments")
    command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("UPDATE materials SET deleted_at='2026-01-01' WHERE id='material'")
        connection.execute(
            "INSERT INTO materials (id,source_id,title,source_sha256,version_id,product_sha256,"
            "contract_version,original_bytes,warnings,compiled_bundle,created_at) "
            "SELECT 'replacement',source_id,title,source_sha256,'new-version',product_sha256,"
            "contract_version,original_bytes,warnings,compiled_bundle,created_at FROM materials"
        )
        connection.commit()
    with pytest.raises(RuntimeError, match="无法无损回退"):
        command.downgrade(config, "0002_lock_analysis_segments")
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT version_num FROM alembic_version").fetchone() == (
            ScriptDirectory.from_config(config).get_current_head(),
        )
        assert connection.execute("SELECT count(*) FROM materials").fetchone() == (2,)
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        for table, rows in dependencies.items():
            assert connection.execute(f"SELECT * FROM {table}").fetchall() == rows


def test_failed_material_rebuild_rolls_back_schema_and_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "invalid.db"
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    command.upgrade(config, "0002_lock_analysis_segments")
    # Simulate a pre-existing corrupt FK. Rebuild must detect it before commit
    # and roll back the new column, index, parent copy and Alembic revision.
    with sqlite3.connect(database) as connection:
        connection.execute(
            "INSERT INTO materials (id,source_id,title,source_sha256,version_id,product_sha256,"
            "contract_version,original_bytes,warnings,compiled_bundle,created_at) "
            "VALUES ('material','missing','本','digest','version','product','v1',?, "
            "'[]',?, '2020-01-01')",
            (b"original", b"compiled"),
        )
        connection.commit()
        before = connection.execute("SELECT * FROM materials").fetchall()
    with pytest.raises(RuntimeError, match="外键校验失败"):
        command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT * FROM materials").fetchall() == before
        assert "deleted_at" not in {
            row[1] for row in connection.execute("PRAGMA table_info(materials)")
        }
        assert connection.execute("SELECT version_num FROM alembic_version").fetchone() == (
            "0002_lock_analysis_segments",
        )
        assert (
            connection.execute(
                "SELECT name FROM sqlite_master WHERE name LIKE '_alembic_tmp_%'"
            ).fetchall()
            == []
        )


def test_provenance_upgrade_preserves_learning_history_and_positions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "provenance-upgrade.db"
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    command.upgrade(config, "0003_material_soft_delete")
    with sqlite3.connect(database) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute(
            "INSERT INTO sources (id,title,description,note,created_at,updated_at) "
            "VALUES ('source','旧資料','説明','備考','2020-01-01','2020-01-02')"
        )
        connection.execute(
            "INSERT INTO segments (id,source_id,text,translation,context_before,context_after,"
            "transcription,note,source_ref,created_at,updated_at,revision,text_locked_at) "
            "VALUES ('segment','source','が𠮷','訳','前','後','聴取','メモ','自由出典',"
            "'2020-01-01','2020-01-02',7,'2020-01-03')"
        )
        connection.execute(
            "INSERT INTO analyses (id,segment_id,operation_key,title,excerpt,current_revision_id,"
            "created_at,updated_at) VALUES ('analysis','segment','old-operation','講解','抜粋',"
            "'revision','2020-01-01','2020-01-02')"
        )
        connection.execute(
            "INSERT INTO analysis_revisions (id,analysis_id,operation_key,operation_payload,"
            "origin,source_md,normalizer_version,warnings,created_at) VALUES "
            "('revision','analysis','old-revision','{}','manual','過去の講解',1,'[]','2020-01-01')"
        )
        connection.execute(
            "INSERT INTO materials (id,source_id,title,source_sha256,version_id,product_sha256,"
            "contract_version,original_bytes,warnings,compiled_bundle,created_at) "
            "VALUES ('material','source','本','digest','old-version','product','v1',X'1234',"
            "'[]',X'5678','2020-01-01')"
        )
        connection.execute(
            "INSERT INTO reading_positions (material_id,revision,payload,updated_at) "
            "VALUES ('material',9,'{\"offset\":7,\"version_id\":\"old-version\"}','2020-01-04')"
        )
        connection.execute(
            "INSERT INTO chapter_reading_positions "
            "(material_id,chapter_id,revision,payload,updated_at) "
            "VALUES ('material','chapter',3,'{\"offset\":2}','2020-01-05')"
        )
        connection.commit()
        before = {
            table: connection.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall()
            for (table,) in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name != 'alembic_version'"
            )
        }
    command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        for table, rows in before.items():
            assert connection.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall() == rows
        assert connection.execute("SELECT * FROM segment_material_provenance").fetchall() == []
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
    # Without new provenance, rolling back this additive migration remains lossless.
    command.downgrade(config, "0003_material_soft_delete")
    command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        for table, rows in before.items():
            assert connection.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall() == rows
        connection.execute(
            "INSERT INTO segment_material_provenance "
            "(segment_id,source_id,material_id,version_id,payload,identity_sha256,request_id,"
            "request_payload,assembly_rule,created_at) VALUES "
            "('segment','source','material','old-version','{}',?,'request','{}',"
            "'concat-nfc-v1','2020-01-06')",
            ("a" * 64,),
        )
        connection.commit()
    with pytest.raises(RuntimeError, match="无法无损回退"):
        command.downgrade(config, "0003_material_soft_delete")
    with sqlite3.connect(database) as connection:
        assert connection.execute(
            "SELECT count(*) FROM segment_material_provenance"
        ).fetchone() == (1,)
        assert connection.execute("SELECT version_num FROM alembic_version").fetchone() == (
            ScriptDirectory.from_config(config).get_current_head(),
        )
        for table, rows in before.items():
            assert connection.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall() == rows


def test_context_settings_migration_preserves_provenance_and_existing_preferences(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "context-upgrade.db"
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    command.upgrade(config, "0004_segment_material_provenance")
    with sqlite3.connect(database) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute(
            "INSERT INTO sources (id,title,description,note,created_at,updated_at) "
            "VALUES ('source','資料','説明','備考','2020-01-01','2020-01-02')"
        )
        connection.execute(
            "INSERT INTO segments (id,source_id,text,translation,context_before,context_after,"
            "transcription,note,source_ref,created_at,updated_at,revision,text_locked_at) "
            "VALUES ('segment','source','対象𠮷','訳','旧前文','旧後文','','','',"
            "'2020-01-01','2020-01-02',7,'2020-01-03')"
        )
        connection.execute(
            "INSERT INTO materials (id,source_id,title,source_sha256,version_id,product_sha256,"
            "contract_version,original_bytes,warnings,compiled_bundle,created_at) "
            "VALUES ('material','source','本','digest','old-version','product','v1',X'1234',"
            "'[]',X'5678','2020-01-01')"
        )
        connection.execute(
            "INSERT INTO segment_material_provenance "
            "(segment_id,source_id,material_id,version_id,payload,identity_sha256,request_id,"
            "request_payload,assembly_rule,created_at) VALUES "
            "('segment','source','material','old-version','{\"ranges\":[]}',?,'request',"
            "'{\"old\":true}','concat-nfc-v1','2020-01-06')",
            ("a" * 64,),
        )
        connection.execute(
            "INSERT INTO learner_profile (id,native_language,explain_language,level_note) "
            "VALUES (1,'中文','日本語','旧背景')"
        )
        connection.execute(
            "INSERT INTO reading_positions (material_id,revision,payload,updated_at) "
            "VALUES ('material',9,'{\"offset\":7}','2020-01-04')"
        )
        connection.commit()
        before = {
            table: connection.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall()
            for (table,) in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name != 'alembic_version'"
            )
        }
    command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        for table, rows in before.items():
            assert connection.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall() == rows
        assert connection.execute("SELECT * FROM segment_context_settings").fetchall() == []
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    command.downgrade(config, "0004_segment_material_provenance")
    command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        connection.execute(
            "INSERT INTO segment_context_settings "
            "(id,enabled,before_sentences,after_sentences,"
            "before_characters,after_characters,revision) "
            "VALUES (1,0,0,7,100000,0,4)"
        )
        connection.commit()
        persisted = connection.execute("SELECT * FROM segment_context_settings").fetchall()
    command.upgrade(config, "head")
    with pytest.raises(RuntimeError, match="无法无损回退"):
        command.downgrade(config, "0004_segment_material_provenance")
    with sqlite3.connect(database) as connection:
        for table, rows in before.items():
            assert connection.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall() == rows
        assert connection.execute("SELECT * FROM segment_context_settings").fetchall() == persisted
        assert connection.execute("SELECT version_num FROM alembic_version").fetchone() == (
            ScriptDirectory.from_config(config).get_current_head(),
        )
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
