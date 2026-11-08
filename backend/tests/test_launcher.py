"""Exercise the frozen CLI's migration and lifecycle seams without network access."""

import asyncio
import socket
import sqlite3
import sys
from pathlib import Path

import pytest
import uvicorn

from app import config, launcher, resources
from app.config import Settings
from app.platform_io import exclusive_file_lock


def test_frozen_assets_and_installation_paths_are_separate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    installation = tmp_path / "安装 Folio-J"
    bundle = installation / "_internal"
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(bundle), raising=False)
    monkeypatch.setattr(sys, "executable", str(installation / "folio-j"))
    assert resources.resource_root() == bundle
    assert resources.installation_root() == installation
    monkeypatch.setattr(config, "REPO_ROOT", resources.installation_root())
    (installation / "config").mkdir(parents=True)
    (installation / "config/app.toml").write_text(
        '[database]\npath = "data/learning.db"\n[server]\nport = 8055\n', encoding="utf-8"
    )
    (bundle / "config").mkdir(parents=True)
    (bundle / "config/app.toml").write_text('[database]\npath = "wrong.db"\n', encoding="utf-8")
    settings = config.load_settings()
    assert settings.database.path == installation / "data/learning.db"
    assert settings.server.port == 8055


def test_cli_migration_rebuilds_empty_database_and_refuses_active_worker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "learning" / "app.db"
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    assert launcher.main(["migrate"]) == 0
    with sqlite3.connect(database) as connection:
        version = connection.execute("SELECT version_num FROM alembic_version").fetchone()
        assert version is not None
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    with exclusive_file_lock(Path(str(database) + ".worker.lock")):
        assert launcher.main(["migrate"]) == 1
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT version_num FROM alembic_version").fetchone() == version


def test_cli_backup_and_restore_preserve_database(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    database = tmp_path / "learning.db"
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    assert launcher.main(["data-path"]) == 0
    assert str(database) in capsys.readouterr().out
    assert not database.exists()
    assert launcher.main(["migrate"]) == 0
    backup, restored = tmp_path / "backup", tmp_path / "restored"
    assert launcher.main(["backup", str(backup)]) == 0
    assert launcher.main(["restore", str(backup), str(restored)]) == 0
    with sqlite3.connect(database) as original, sqlite3.connect(restored / "app.db") as copy:
        assert list(original.iterdump()) == list(copy.iterdump())
    assert launcher.main(["restore", str(backup), str(restored)]) == 1


@pytest.mark.parametrize("ready", [False, True])
@pytest.mark.parametrize("no_browser", [False, True])
def test_browser_opens_only_after_successful_startup(
    ready: bool, no_browser: bool, monkeypatch: pytest.MonkeyPatch
) -> None:
    opened: list[str] = []

    async def startup(server: uvicorn.Server, sockets: list[socket.socket] | None = None) -> None:
        assert opened == []
        server.started = ready

    def open_browser(url: str) -> bool:
        opened.append(url)
        return True

    monkeypatch.setattr(uvicorn.Server, "startup", startup)
    monkeypatch.setattr(launcher.webbrowser, "open", open_browser)
    url = "http://127.0.0.1:8010"
    server = launcher.BrowserServer(uvicorn.Config("unused"), None if no_browser else url)
    asyncio.run(server.startup())
    assert opened == ([url] if ready and not no_browser else [])


def test_start_migrates_before_in_process_server(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    frontend = tmp_path / "frontend/dist"
    frontend.mkdir(parents=True)
    (frontend / "index.html").write_text("<html>Folio-J</html>", encoding="utf-8")
    monkeypatch.setattr(launcher, "RESOURCE_ROOT", tmp_path)
    events: list[str] = []

    def migrate(database_path: Path | None = None) -> None:
        assert database_path == Settings().database.path
        events.append("migrate")

    def run(server: launcher.BrowserServer) -> None:
        assert events == ["migrate"]
        assert server.config.workers == 1
        assert not isinstance(server.config.app, str)
        assert server.browser_url is None
        events.append("serve")
        server.started = True

    monkeypatch.setattr(launcher, "migrate", migrate)
    monkeypatch.setattr(launcher.BrowserServer, "run", run)
    assert launcher.start(Settings(), no_browser=True) == 0
    assert events == ["migrate", "serve"]


def test_start_checks_frontend_before_touching_database(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(launcher, "RESOURCE_ROOT", tmp_path)
    database = tmp_path / "untouched.db"
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    assert launcher.main(["start", "--no-browser"]) == 1
    assert not database.exists()


def test_browser_failure_keeps_server_ready(monkeypatch: pytest.MonkeyPatch) -> None:
    async def startup(server: uvicorn.Server, sockets: list[socket.socket] | None = None) -> None:
        server.started = True

    def open_browser(url: str) -> bool:
        raise OSError("browser executable unavailable")

    monkeypatch.setattr(uvicorn.Server, "startup", startup)
    monkeypatch.setattr(launcher.webbrowser, "open", open_browser)
    server = launcher.BrowserServer(uvicorn.Config("unused"), "http://127.0.0.1:8010")
    asyncio.run(server.startup())
    assert server.started


@pytest.mark.parametrize("ready", [False, True])
@pytest.mark.parametrize("interrupt", [False, True])
def test_server_exit_preserves_startup_result_after_cleanup(
    ready: bool, interrupt: bool, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    frontend = tmp_path / "frontend/dist"
    frontend.mkdir(parents=True)
    (frontend / "index.html").write_text("Folio-J", encoding="utf-8")
    monkeypatch.setattr(launcher, "RESOURCE_ROOT", tmp_path)
    cleanup: list[str] = []

    def migrate(database_path: Path | None = None) -> None:
        pass

    def run(server: launcher.BrowserServer) -> None:
        server.started = ready
        try:
            if interrupt:
                raise KeyboardInterrupt
        finally:
            cleanup.append("complete")

    monkeypatch.setattr(launcher, "migrate", migrate)
    monkeypatch.setattr(launcher.BrowserServer, "run", run)
    assert launcher.start(Settings(), no_browser=True) == (0 if ready else 1)
    assert cleanup == ["complete"]


def test_server_bind_failure_is_not_reported_as_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    frontend = tmp_path / "frontend/dist"
    frontend.mkdir(parents=True)
    (frontend / "index.html").write_text("Folio-J", encoding="utf-8")
    monkeypatch.setattr(launcher, "RESOURCE_ROOT", tmp_path)

    def migrate(database_path: Path | None = None) -> None:
        pass

    def run(server: launcher.BrowserServer) -> None:
        raise SystemExit(1)

    monkeypatch.setattr(launcher, "migrate", migrate)
    monkeypatch.setattr(launcher.BrowserServer, "run", run)
    with pytest.raises(SystemExit) as stopped:
        launcher.start(Settings(), no_browser=True)
    assert stopped.value.code == 1
