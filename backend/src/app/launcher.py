"""Production CLI shared by source installs and the standalone executable."""

from __future__ import annotations

import argparse
import asyncio
import signal
import socket
import sqlite3
import stat
import sys
import webbrowser
from collections.abc import Sequence
from contextlib import closing
from io import TextIOWrapper
from pathlib import Path
from types import FrameType

import uvicorn
from alembic.config import Config
from alembic.util.exc import CommandError
from starlette.types import ASGIApp as ASGIApplication

from alembic import command
from app.backup import create_backup, restore_backup
from app.config import Settings, default_database_path, load_settings, read_startup_server
from app.platform_io import (
    FileLockError,
    exclusive_file_lock,
    make_private_directory,
    publish_file,
    staging_directory,
)
from app.resources import RESOURCE_ROOT
from app.services import data_location


def _upgrade(database: Path, *, target: Path) -> None:
    configuration = Config()
    configuration.attributes["database_path"] = database
    configuration.attributes["database_target"] = target
    configuration.attributes["require_existing"] = database == target
    configuration.set_main_option("script_location", str(RESOURCE_ROOT / "backend/alembic"))
    command.upgrade(configuration, "head")


def _checkpoint_staged_database(staged: Path, target: Path) -> None:
    wal = Path(f"{staged}-wal")
    if not wal.is_file() or wal.stat().st_size == 0:
        return
    with closing(sqlite3.connect(staged)) as connection:
        checkpoint = connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        if checkpoint is None or checkpoint[0] != 0:
            raise data_location.DataLocationError(f"无法完成数据库的初始写入：{target}。请重试。")


def _initialize_database(database: Path) -> None:
    data_location.require_new_database_path(database)
    published = False
    try:
        with staging_directory(database.parent, prefix=".folio-j-create-") as directory:
            staged = directory / database.name
            _upgrade(staged, target=database)
            _checkpoint_staged_database(staged, database)
            data_location.require_new_database_path(database)
            try:
                publish_file(staged, database)
            except FileExistsError as exc:
                raise data_location.DataLocationError(
                    f"该位置已有数据库文件：{database}。请重新选择数据位置。"
                ) from exc
            published = True
    except OSError as exc:
        if not published:
            raise
        # The final file is complete. A temporary directory cleanup failure
        # must not turn it back into a pending creation.
        print(
            f"新数据库已建立，暂存目录清理失败：{database}（{type(exc).__name__}）",
            file=sys.stderr,
            flush=True,
        )


def migrate(database_path: Path | None = None, require_existing: bool | None = None) -> None:
    """Migrate under the same offline lock used by workers and backup operations."""
    database = database_path if database_path is not None else load_settings().database.path
    make_private_directory(database.parent, parents=True, exist_ok=True)
    lock = database.with_name(database.name + ".worker.lock")
    try:
        with exclusive_file_lock(lock):
            if require_existing is None:
                require_existing = database.is_file()
            if require_existing:
                try:
                    is_regular_file = stat.S_ISREG(database.stat().st_mode)
                except FileNotFoundError:
                    is_regular_file = False
                if not is_regular_file:
                    raise data_location.DataLocationError(f"找不到可用的数据库文件：{database}")
                data_location.validate_library_identity(database)
                _upgrade(database, target=database)
            else:
                _initialize_database(database)
    except FileLockError as exc:
        if isinstance(exc.__cause__, PermissionError):
            raise data_location.DataLocationError(
                f"没有权限访问数据库锁文件：{lock}。请在启动页选择可写的数据目录。"
            ) from exc
        raise data_location.DataLocationError(
            f"无法使用数据库文件：{database}。请检查数据目录是否可写，并关闭正在使用该文件的其他程序后重试。\n详细信息：{exc}"
        ) from exc


class BrowserServer(uvicorn.Server):
    """Open the system browser only after ASGI startup and socket binding succeed."""

    def __init__(self, config: uvicorn.Config, url: str | None) -> None:
        super().__init__(config)
        self.browser_url = url

    def handle_exit(self, sig: int, frame: FrameType | None) -> None:
        # A second console stop must not force-exit while database resources close,
        # or queue another signal for Uvicorn to replay after that cleanup.
        if not self.should_exit:
            super().handle_exit(sig, frame)

    async def startup(self, sockets: list[socket.socket] | None = None) -> None:
        await super().startup(sockets=sockets)
        if self.started and not self.should_exit and self.browser_url is not None:
            try:
                await asyncio.to_thread(webbrowser.open, self.browser_url)
            except (OSError, webbrowser.Error) as exc:
                print(
                    f"无法自动打开浏览器，请手动访问 {self.browser_url}。详细信息：{exc}",
                    file=sys.stderr,
                )


def start_interactive(*, no_browser: bool, choose_data: bool = False) -> int:
    """Use a database-independent page for first selection and startup recovery."""
    from app.main import create_app
    from app.services.data_location import LocationStatus, location_status
    from app.services.startup import StartupService
    from app.startup import StartupApplication

    frontend = RESOURCE_ROOT / "frontend/dist"
    if not (frontend / "index.html").is_file():
        raise ValueError("缺少应用页面文件，请重新解压完整程序包。使用源码版时，请先构建前端。")
    settings = Settings(server=read_startup_server())
    service = StartupService(
        LocationStatus(
            settings=None,
            needs_selection=True,
            recovery=False,
            selected_path=None,
            default_path=default_database_path(),
        ),
        migrate,
        lambda database: create_app(
            frontend_dir=frontend, database_path=database, require_existing=True
        ),
        load_location=location_status,
        choose_data=choose_data,
    )
    return _serve(StartupApplication(service), settings, no_browser=no_browser)


def _serve(application: ASGIApplication, settings: Settings, *, no_browser: bool) -> int:
    url = f"http://{settings.server.host}:{settings.server.port}"
    print(f"浏览器访问地址：{url}", flush=True)
    print("按 Ctrl-C 停止服务。", flush=True)
    configuration = uvicorn.Config(
        application,
        host=settings.server.host,
        port=settings.server.port,
        loop="asyncio",
        http="h11",
        ws="none",
        lifespan="on",
        # A Windows console can be a TTY without interpreting ANSI sequences.
        use_colors=False if sys.platform == "win32" else None,
    )
    server = BrowserServer(configuration, None if no_browser else url)
    previous_sigbreak = None
    if sys.platform == "win32":
        # Uvicorn restores and replays SIGBREAK after cleanup. Its Windows
        # default would terminate the process instead of reaching our normal stop.
        previous_sigbreak = signal.signal(signal.SIGBREAK, signal.default_int_handler)
    try:
        server.run()
    except KeyboardInterrupt:
        # Uvicorn replays stop signals after its ASGI cleanup has finished. Treat that
        # normal terminal stop as success only if startup had completed.
        pass
    finally:
        if sys.platform == "win32" and previous_sigbreak is not None:
            signal.signal(signal.SIGBREAK, previous_sigbreak)
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
    serve.add_argument("--choose-data", action="store_true", help="重新选择数据目录后启动")
    commands.add_parser("data-path", help="显示下次启动使用的数据库文件路径")
    commands.add_parser("migrate", help="停止服务后将数据库升级到当前版本")
    backup = commands.add_parser("backup", help="停止服务后将数据备份到新目录")
    backup.add_argument("destination", type=Path)
    restore = commands.add_parser("restore", help="将 Folio-J 备份恢复到新数据目录")
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
            print("备份可能包含未加密的 API 密钥，请将整个备份目录保存在私有位置，并避免分享。")
        elif arguments.command == "migrate":
            migrate()
        elif arguments.command == "data-path":
            print(f"下次迁移和启动时使用的数据库文件：{load_settings().database.path}")
            print("可使用 start --choose-data 打开启动页，重新选择数据目录。")
        else:
            return start_interactive(
                no_browser=bool(getattr(arguments, "no_browser", False)),
                choose_data=bool(getattr(arguments, "choose_data", False)),
            )
    except (ValueError, OSError, sqlite3.Error, CommandError) as exc:
        print(f"操作失败：{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
