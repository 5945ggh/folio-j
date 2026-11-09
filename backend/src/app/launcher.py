"""Production CLI shared by source installs and the standalone executable."""

from __future__ import annotations

import argparse
import asyncio
import signal
import socket
import sqlite3
import sys
import webbrowser
from collections.abc import Sequence
from io import TextIOWrapper
from pathlib import Path

import uvicorn
from alembic.config import Config
from alembic.util.exc import CommandError

from alembic import command
from app.backup import create_backup, restore_backup
from app.config import USER_DIRECTORY, Settings, load_settings
from app.platform_io import FileLockError, exclusive_file_lock
from app.resources import RESOURCE_ROOT


def migrate(database_path: Path | None = None) -> None:
    """Migrate under the same offline lock used by workers and backup operations."""
    database = database_path if database_path is not None else load_settings().database.path
    database.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = database.with_name(database.name + ".worker.lock")
    try:
        with exclusive_file_lock(lock):
            configuration = Config()
            configuration.attributes["database_path"] = database
            configuration.set_main_option("script_location", str(RESOURCE_ROOT / "backend/alembic"))
            command.upgrade(configuration, "head")
    except FileLockError as exc:
        raise ValueError(f"请先停止使用此数据库的全部服务：{database}") from exc


class BrowserServer(uvicorn.Server):
    """Open the system browser only after ASGI startup and socket binding succeed."""

    def __init__(self, config: uvicorn.Config, url: str | None) -> None:
        super().__init__(config)
        self.browser_url = url

    async def startup(self, sockets: list[socket.socket] | None = None) -> None:
        await super().startup(sockets=sockets)
        if self.started and not self.should_exit and self.browser_url is not None:
            try:
                await asyncio.to_thread(webbrowser.open, self.browser_url)
            except (OSError, webbrowser.Error) as exc:
                print(f"无法自动打开浏览器，请手动访问 {self.browser_url}：{exc}", file=sys.stderr)


def start(settings: Settings, *, no_browser: bool) -> int:
    frontend = RESOURCE_ROOT / "frontend/dist"
    if not (frontend / "index.html").is_file():
        raise ValueError("缺少前端构建，请重新安装完整程序包或先构建前端。")
    migrate(settings.database.path)
    # Import directly so PyInstaller can discover the application and avoid
    # spawning sys.executable -m uvicorn (which would restart the frozen CLI).
    from app.main import create_app

    url = f"http://{settings.server.host}:{settings.server.port}"
    print(f"数据库：{settings.database.path}", flush=True)
    print(f"启动访问地址：{url}", flush=True)
    print("按 Ctrl-C 停止服务。", flush=True)
    configuration = uvicorn.Config(
        create_app(frontend_dir=frontend, database_path=settings.database.path),
        host=settings.server.host,
        port=settings.server.port,
        loop="asyncio",
        http="h11",
        ws="none",
        lifespan="on",
    )
    server = BrowserServer(configuration, None if no_browser else url)
    sigbreak = signal.SIGBREAK if sys.platform == "win32" else None
    previous_sigbreak = None
    if sigbreak is not None:
        # Uvicorn restores and replays SIGBREAK after cleanup. Its Windows
        # default would terminate the process instead of reaching our normal stop.
        previous_sigbreak = signal.signal(sigbreak, signal.default_int_handler)
    try:
        server.run()
    except KeyboardInterrupt:
        # Uvicorn replays stop signals after its ASGI cleanup has finished. Treat that
        # normal terminal stop as success only if startup had completed.
        pass
    finally:
        if sigbreak is not None and previous_sigbreak is not None:
            signal.signal(sigbreak, previous_sigbreak)
    return 0 if server.started else 1


def main(argv: Sequence[str] | None = None) -> int:
    if sys.platform == "win32":
        # Redirected Windows streams may use cp936 even when the console supports
        # Unicode. Keep paths and diagnostics printable, including lone surrogates.
        for stream in (sys.stdout, sys.stderr):
            if isinstance(stream, TextIOWrapper):
                stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Folio-J 本地浏览器应用")
    commands = parser.add_subparsers(dest="command")
    serve = commands.add_parser("start", help="升级数据库并启动，默认打开系统浏览器")
    serve.add_argument("--no-browser", action="store_true", help="启动后不自动打开浏览器")
    commands.add_parser("data-path", help="显示下次启动使用的数据库路径")
    commands.add_parser("migrate", help="停服后将数据库升级到当前版本")
    backup = commands.add_parser("backup", help="停服后备份到新目录")
    backup.add_argument("destination", type=Path)
    restore = commands.add_parser("restore", help="将原生备份恢复到新目录")
    restore.add_argument("backup", type=Path)
    restore.add_argument("destination", type=Path)
    arguments = parser.parse_args(argv)
    try:
        if arguments.command == "restore":
            result = restore_backup(arguments.backup, arguments.destination)
            print(f"恢复完成：{result}")
        elif arguments.command == "backup":
            result = create_backup(arguments.destination)
            print(f"备份完成：{result}")
            print("此备份可能包含未加密的模型密钥，请私下保管整个目录。")
        elif arguments.command == "migrate":
            migrate()
        elif arguments.command == "data-path":
            print(f"下次迁移和启动使用的数据库：{load_settings().database.path}")
            print(
                f"首次使用如需自选位置，请先在 {USER_DIRECTORY / 'app.toml'} "
                "中设置 [database].path。"
            )
        else:
            return start(load_settings(), no_browser=bool(getattr(arguments, "no_browser", False)))
    except (ValueError, OSError, sqlite3.Error, CommandError) as exc:
        print(f"操作失败：{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
