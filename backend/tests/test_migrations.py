"""Exercise empty-database rebuilds and Alembic's temporary generation path."""

import shutil
import sqlite3
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
    assert len(revisions) == 1
    assert revisions[0].down_revision is None
    assert scripts.get_bases() == scripts.get_heads() == [revisions[0].revision]
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
