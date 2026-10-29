"""Fixed baseline and incremental revisions rebuild and preserve existing data."""

import shutil
import sqlite3
from pathlib import Path

import pytest
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from alembic.util.exc import CommandError
from sqlalchemy import (
    URL,
    CheckConstraint,
    Column,
    Integer,
    MetaData,
    Table,
    create_engine,
    inspect,
)

from alembic import command
from app import (
    analysis_models,
    chat_models,
    context_copy_models,
    material_models,
    models,
    segment_context_models,
    settings_models,
    translation_models,
)
from app.db import Base

_ = (
    analysis_models,
    chat_models,
    context_copy_models,
    material_models,
    models,
    settings_models,
    segment_context_models,
    translation_models,
)
BASELINE = "0001_schema_baseline"
HEAD = "0002_context_copy_settings"
SCRIPTS = Path(__file__).resolve().parents[1] / "alembic"


def _config(database: Path, monkeypatch: pytest.MonkeyPatch, scripts: Path = SCRIPTS) -> Config:
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    config = Config()
    config.set_main_option("script_location", str(scripts))
    return config


def _schema(database: Path) -> list[tuple[str, str, str | None]]:
    with sqlite3.connect(database) as connection:
        return connection.execute(
            "SELECT type,name,sql FROM sqlite_master ORDER BY type,name"
        ).fetchall()


def _rows(database: Path) -> dict[str, list[tuple[object, ...]]]:
    with sqlite3.connect(database) as connection:
        return {
            table: connection.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall()
            for (table,) in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }


def _seed_history(database: Path) -> None:
    """Include parent/child revisions so FK-safe downgrade covers self-reference."""
    with sqlite3.connect(database) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute(
            "INSERT INTO sources (id,title,description,note,created_at,updated_at) "
            "VALUES ('source','資料𠮷','説明','備考','2020-01-01','2020-01-02')"
        )
        connection.execute(
            "INSERT INTO segments (id,source_id,text,translation,context_before,context_after,"
            "transcription,note,source_ref,created_at,updated_at,revision) VALUES "
            "('segment','source','が𠮷','訳','前','後','聴取','メモ','自由出典',"
            "'2020-01-01','2020-01-02',7)"
        )
        connection.execute(
            "INSERT INTO analyses (id,segment_id,operation_key,title,excerpt,current_revision_id,"
            "created_at,updated_at) VALUES ('analysis','segment','operation','講解','抜粋',"
            "'child','2020-01-01','2020-01-02')"
        )
        for revision, parent in (("parent", None), ("child", "parent")):
            connection.execute(
                "INSERT INTO analysis_revisions (id,analysis_id,parent_revision_id,operation_key,"
                "operation_payload,origin,source_md,normalizer_version,warnings,created_at) "
                "VALUES (?,'analysis',?,?,'{}','manual','不変の講解𠮷',1,'[]','2020-01-01')",
                (revision, parent, revision),
            )
        connection.execute(
            "INSERT INTO materials (id,source_id,title,source_sha256,version_id,product_sha256,"
            "contract_version,original_bytes,warnings,compiled_bundle,created_at) "
            "VALUES ('material','source','本','digest','version','product','v1',X'1234',"
            "'[]',X'5678','2020-01-01')"
        )
        connection.execute(
            "INSERT INTO reading_positions (material_id,revision,payload,updated_at) "
            "VALUES ('material',9,'{\"offset\":7}','2020-01-04')"
        )
        connection.execute(
            "INSERT INTO segment_context_settings (id,enabled,before_sentences,after_sentences,"
            "before_characters,after_characters,revision) VALUES (1,0,0,7,100000,0,4)"
        )


def _temporary_revision(tmp_path: Path, body: str) -> Path:
    scripts = tmp_path / "alembic"
    shutil.copytree(SCRIPTS, scripts, ignore=shutil.ignore_patterns("__pycache__"))
    (scripts / "versions" / "future_test.py").write_text(
        "from alembic import op\n"
        "import sqlalchemy as sa\n"
        "revision = 'future_test'\n"
        f"down_revision = {HEAD!r}\n"
        "branch_labels = None\ndepends_on = None\n"
        "def upgrade():\n"
        "    assert op.get_bind().exec_driver_sql('PRAGMA foreign_keys').scalar_one() == 1\n"
        "    op.create_table('transient', sa.Column('id', sa.Integer(), primary_key=True))\n"
        + body
        + "\ndef downgrade():\n    op.drop_table('transient')\n",
        encoding="utf-8",
    )
    return scripts


def test_empty_database_rebuilds_current_schema(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "empty.db"
    config = _config(database, monkeypatch)
    scripts = ScriptDirectory.from_config(config)
    revisions = list(scripts.walk_revisions())
    assert [revision.revision for revision in revisions] == [HEAD, BASELINE]
    assert revisions[0].down_revision == BASELINE
    assert revisions[1].down_revision is None
    assert scripts.get_bases() == [BASELINE]
    assert scripts.get_heads() == [HEAD]
    command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT version_num FROM alembic_version").fetchall() == [(HEAD,)]
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        tables = {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        assert len(Base.metadata.tables) == 29
        assert tables == {"alembic_version", *Base.metadata.tables}
    engine = create_engine(URL.create("sqlite", database=str(database)))
    try:
        with engine.connect() as connection:
            context = MigrationContext.configure(connection, opts={"compare_type": True})
            assert compare_metadata(context, Base.metadata) == []
            inspector = inspect(connection)
            defaults = {
                (table.name, column["name"]): column["default"]
                for table in Base.metadata.tables.values()
                for column in inspector.get_columns(table.name)
                if column["default"] is not None
            }
            # Historical SQL defaults deliberately differ from ORM insert defaults.
            assert defaults == {
                ("chat_jobs", "execution_state"): "'{}'",
                ("material_covers", "rule_version"): "'1'",
                ("material_covers", "diagnostic_reason"): "'legacy_cache'",
                ("materials", "metadata_revision"): "'0'",
                ("runs", "purpose"): "'verification'",
                ("segments", "revision"): "'1'",
            }
            for table in Base.metadata.tables.values():
                assert inspector.get_pk_constraint(table.name)["constrained_columns"] == [
                    column.name for column in table.primary_key.columns
                ]
                actual_checks = {
                    (item["name"], "".join(item["sqltext"].split()).lower())
                    for item in inspector.get_check_constraints(table.name)
                }
                expected_checks = {
                    (item.name, "".join(str(item.sqltext).split()).lower())
                    for item in table.constraints
                    if isinstance(item, CheckConstraint)
                }
                assert actual_checks == expected_checks
                indexes = {item["name"]: item for item in inspector.get_indexes(table.name)}
                for index in table.indexes:
                    where = index.dialect_options["sqlite"].get("where")
                    if where is not None:
                        actual = indexes[index.name].get("dialect_options", {}).get("sqlite_where")
                        assert actual is not None
                        assert (
                            "".join(str(actual).split()).lower()
                            == "".join(str(where).split()).lower()
                        )
    finally:
        engine.dispose()


def test_repeated_upgrade_preserves_all_existing_rows_and_schema(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "preserved.db"
    config = _config(database, monkeypatch)
    command.upgrade(config, "head")
    _seed_history(database)
    before, schema = _rows(database), _schema(database)
    command.upgrade(config, "head")
    command.upgrade(config, "head")
    assert _rows(database) == before
    assert _schema(database) == schema


def test_full_downgrade_and_rebuild_with_self_referencing_history(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "roundtrip.db"
    config = _config(database, monkeypatch)
    command.upgrade(config, "head")
    original_schema = _schema(database)
    _seed_history(database)
    command.downgrade(config, "base")
    assert _rows(database) == {"alembic_version": []}
    command.upgrade(config, "head")
    assert _schema(database) == original_schema
    with sqlite3.connect(database) as connection:
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)


def test_revision_ddl_does_not_follow_runtime_metadata_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    original = tmp_path / "original.db"
    command.upgrade(_config(original, monkeypatch), "head")
    expected = _schema(original)
    future_metadata = MetaData()
    Table("orm_only_future_table", future_metadata, Column("id", Integer, primary_key=True))
    monkeypatch.setattr(Base, "metadata", future_metadata)
    rebuilt = tmp_path / "static.db"
    command.upgrade(_config(rebuilt, monkeypatch), "head")
    assert _schema(rebuilt) == expected


def test_revision_generation_and_upgrade_in_temporary_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    scripts = tmp_path / "alembic"
    scripts.mkdir()
    (scripts / "versions").mkdir()
    for name in ("env.py", "script.py.mako"):
        shutil.copy2(SCRIPTS / name, scripts / name)
    database = tmp_path / "generated.db"
    config = _config(database, monkeypatch, scripts)
    command.revision(config, message="temporary smoke", rev_id="smoke001")
    assert len(list((scripts / "versions").glob("smoke001_*.py"))) == 1
    command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT version_num FROM alembic_version").fetchone() == (
            "smoke001",
        )


def test_failed_future_ddl_and_data_are_rolled_back_with_foreign_keys_enabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "failed.db"
    command.upgrade(_config(database, monkeypatch), "head")
    _seed_history(database)
    before, schema = _rows(database), _schema(database)
    scripts = _temporary_revision(
        tmp_path,
        "    op.execute(\"UPDATE sources SET title='must roll back'\")\n"
        "    raise RuntimeError('injected DDL failure')\n",
    )
    with pytest.raises(RuntimeError, match="injected DDL failure"):
        command.upgrade(_config(database, monkeypatch, scripts), "head")
    assert _rows(database) == before
    assert _schema(database) == schema


def test_final_foreign_key_check_rejects_existing_orphans_and_rolls_back_ddl(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "orphan.db"
    command.upgrade(_config(database, monkeypatch), "head")
    with sqlite3.connect(database) as connection:
        connection.execute("PRAGMA foreign_keys=OFF")
        connection.execute(
            "INSERT INTO materials (id,source_id,title,source_sha256,version_id,product_sha256,"
            "contract_version,original_bytes,warnings,compiled_bundle,created_at) "
            "VALUES ('material','missing','本','digest','version','product','v1',X'1234',"
            "'[]',X'5678','2020-01-01')"
        )
        assert connection.execute("PRAGMA foreign_key_check").fetchall()
    before, schema = _rows(database), _schema(database)
    scripts = _temporary_revision(tmp_path, "")
    with pytest.raises(RuntimeError, match="外键校验失败"):
        command.upgrade(_config(database, monkeypatch, scripts), "head")
    assert _rows(database) == before
    assert _schema(database) == schema


@pytest.mark.parametrize("old_revision", ["0001_initial", "0006_translations"])
def test_old_revision_labels_are_not_silently_accepted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, old_revision: str
) -> None:
    database = tmp_path / "old.db"
    config = _config(database, monkeypatch)
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) PRIMARY KEY)")
        connection.execute("INSERT INTO alembic_version VALUES (?)", (old_revision,))
        connection.execute("CREATE TABLE preserved (value TEXT)")
        connection.execute("INSERT INTO preserved VALUES ('do not rebuild')")
    before, schema = _rows(database), _schema(database)
    with pytest.raises(CommandError, match="Can't locate revision"):
        command.upgrade(config, "head")
    assert _rows(database) == before
    assert _schema(database) == schema


def test_baseline_upgrade_only_adds_context_copy_settings_and_preserves_history(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "upgrade-existing.db"
    config = _config(database, monkeypatch)
    command.upgrade(config, BASELINE)
    _seed_history(database)
    before, schema = _rows(database), _schema(database)
    assert "context_copy_settings" not in before

    command.upgrade(config, "head")
    after = _rows(database)
    assert after.pop("context_copy_settings") == []
    assert after.pop("alembic_version") == [(HEAD,)]
    assert before.pop("alembic_version") == [(BASELINE,)]
    assert after == before
    assert [entry for entry in _schema(database) if entry[1] != "context_copy_settings"] == schema
    with sqlite3.connect(database) as connection:
        connection.execute(
            "INSERT INTO context_copy_settings "
            "(id,include_source,before_sentences,after_sentences,before_characters,"
            "after_characters,revision) VALUES (1,0,5,2,300,50,8)"
        )
    head_rows, head_schema = _rows(database), _schema(database)
    command.upgrade(config, "head")
    assert _rows(database) == head_rows
    assert _schema(database) == head_schema

    command.downgrade(config, BASELINE)
    assert _rows(database) == {**before, "alembic_version": [(BASELINE,)]}
    assert _schema(database) == schema
    command.upgrade(config, "head")
    assert _schema(database) == head_schema
    assert _rows(database)["context_copy_settings"] == []
