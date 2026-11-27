"""Database publication and read-only identity checks at startup."""

import shutil
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

import pytest
from alembic.config import Config
from fastapi import FastAPI
from sqlalchemy.exc import OperationalError
from support_paths import symlink_or_skip

from app import launcher
from app.db import sqlite_file_uri
from app.services import data_location
from app.services.startup import StartupSelection, StartupService


@pytest.mark.asyncio
@pytest.mark.parametrize("restart", [False, True], ids=["retry", "restart"])
async def test_failed_initial_migration_leaves_name_available(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, restart: bool
) -> None:
    scripts = tmp_path / "alembic"
    shutil.copytree(launcher.RESOURCE_ROOT / "backend/alembic", scripts)
    revision = scripts / "versions/0005_anki_settings.py"
    original = revision.read_text(encoding="utf-8")
    revision.write_text(
        original.replace(
            "def upgrade() -> None:",
            "def upgrade() -> None:\n    raise RuntimeError('injected initial migration failure')",
        ),
        encoding="utf-8",
    )
    upgrade = launcher.command.upgrade
    rolled_back: list[Path] = []

    def fail_after_open(config: Config, target: str) -> None:
        config.set_main_option("script_location", str(scripts))
        with pytest.raises(RuntimeError, match="injected initial migration failure"):
            upgrade(config, target)
        staged = config.attributes["database_path"]
        assert isinstance(staged, Path)
        assert staged.is_file()
        with closing(sqlite3.connect(staged)) as connection:
            assert connection.execute("SELECT name FROM sqlite_master").fetchall() == []
        rolled_back.append(staged)
        raise RuntimeError("injected initial migration failure")

    chosen = tmp_path / "chosen"
    choice = StartupSelection(directory=str(chosen), mode="new")
    database = chosen / "app.db"

    def new_service() -> StartupService:
        return StartupService(
            data_location.location_status(), launcher.migrate, lambda _: FastAPI()
        )

    service = new_service()
    with monkeypatch.context() as patch:
        patch.setattr(launcher.command, "upgrade", fail_after_open)
        failed = await service.select(choice)
    assert failed.recovery
    assert failed.retry_current_path == str(database)
    assert len(rolled_back) == 1 and not rolled_back[0].parent.exists()
    assert not database.exists()
    assert (chosen / "app.db.worker.lock").is_file()
    assert data_location.read_selection() is None
    if restart:
        await service.close()
        service = new_service()
        recovered = await service.select(choice)
    else:
        recovered = await service.retry_current()
    try:
        assert recovered.ready
        assert database.is_file()
        assert data_location.read_selection() == database
    finally:
        await service.close()


def test_new_selection_does_not_follow_dangling_database_link(tmp_path: Path) -> None:
    directory = tmp_path / "chosen"
    directory.mkdir()
    other = tmp_path / "elsewhere.db"
    symlink_or_skip(directory / "app.db", other)
    with pytest.raises(data_location.DataLocationError, match="链接占用"):
        data_location.prepare_selection(directory)
    assert not other.exists()


def test_initial_migration_never_replaces_target_created_after_selection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = data_location.prepare_selection(tmp_path / "chosen").database.path
    upgrades = launcher.command.upgrade
    unrelated = b""

    def create_competing_database(config: Config, target: str) -> None:
        nonlocal unrelated
        upgrades(config, target)
        with closing(sqlite3.connect(database)) as connection, connection:
            connection.execute("CREATE TABLE another_application (value TEXT)")
            connection.execute("INSERT INTO another_application VALUES ('keep')")
        unrelated = database.read_bytes()

    with monkeypatch.context() as patch:
        patch.setattr(launcher.command, "upgrade", create_competing_database)
        with pytest.raises(data_location.DataLocationError, match="已有数据库"):
            launcher.migrate(database, require_existing=False)
    assert database.read_bytes() == unrelated
    with pytest.raises(data_location.DataLocationError, match="无法识别"):
        launcher.migrate(database, require_existing=True)
    assert database.read_bytes() == unrelated


def test_initial_migration_preserves_existing_library_and_refuses_missing_existing(
    tmp_path: Path,
) -> None:
    existing = tmp_path / "app.db"
    launcher.migrate(existing, require_existing=False)
    before = existing.read_bytes()
    with pytest.raises(data_location.DataLocationError, match="已有数据库"):
        launcher.migrate(existing, require_existing=False)
    assert existing.read_bytes() == before

    missing = tmp_path / "missing.db"
    with pytest.raises(data_location.DataLocationError, match="找不到可用的数据库文件"):
        launcher.migrate(missing, require_existing=True)
    assert not missing.exists()


def test_upgrade_cannot_recreate_library_moved_after_identity_check(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    filename = "罕字 % #.db" if sys.platform == "win32" else "罕字 % ? #.db"
    database = tmp_path / filename
    launcher.migrate(database, require_existing=False)
    launcher.migrate(database, require_existing=True)
    original = database.read_bytes()
    relocated = database.with_suffix(".moved")
    validate = data_location.validate_library_identity

    def move_after_check(path: Path) -> None:
        validate(path)
        assert path == database
        path.rename(relocated)

    monkeypatch.setattr(data_location, "validate_library_identity", move_after_check)
    with pytest.raises(OperationalError, match="unable to open database file"):
        launcher.migrate(database, require_existing=True)
    assert not database.exists()
    assert relocated.read_bytes() == original


def test_sqlite_uri_preserves_drive_and_moves_unc_server_to_path() -> None:
    drive = "file:///D:/Study%20%25%20%23/app.db"
    unc = "file://server/share/Study%20%25%20%23/app.db"
    assert sqlite_file_uri(drive) == drive
    assert sqlite_file_uri(unc) == "file:////server/share/Study%20%25%20%23/app.db"


@pytest.mark.parametrize("library_in_wal", [True, False], ids=["learn", "unrelated"])
def test_identity_reads_committed_wal_without_touching_original_files(
    tmp_path: Path, library_in_wal: bool
) -> None:
    source = tmp_path / "source.db"
    if not library_in_wal:
        launcher.migrate(source, require_existing=False)
    chosen = tmp_path / "chosen"
    chosen.mkdir()
    database = chosen / "app.db"
    with closing(sqlite3.connect(source)) as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA wal_autocheckpoint=0")
        with connection:
            if library_in_wal:
                connection.execute("CREATE TABLE alembic_version (version_num TEXT)")
                connection.execute("INSERT INTO alembic_version VALUES ('0005_anki_settings')")
                for table in ("sources", "materials", "segments"):
                    connection.execute(f"CREATE TABLE {table} (id INTEGER)")
            else:
                connection.execute("DROP TABLE alembic_version")
                connection.execute("CREATE TABLE unrelated (value TEXT)")

        # Copy only the main file and WAL while the writer still holds them open.
        # No shared memory file exists in the chosen data directory.
        shutil.copyfile(source, database)
        shutil.copyfile(Path(f"{source}-wal"), Path(f"{database}-wal"))

    before = {entry.name: entry.read_bytes() for entry in chosen.iterdir()}
    if library_in_wal:
        settings = data_location.prepare_selection(database, use_existing=True)
        assert settings.database.path == database
    else:
        with pytest.raises(data_location.DataLocationError, match="无法识别"):
            data_location.prepare_selection(database, use_existing=True)
    assert {entry.name: entry.read_bytes() for entry in chosen.iterdir()} == before
