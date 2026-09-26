"""Exercise Alembic's generation path without adding a repository migration."""

import shutil
import sqlite3
from pathlib import Path

import pytest
from alembic.config import Config

from alembic import command


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
