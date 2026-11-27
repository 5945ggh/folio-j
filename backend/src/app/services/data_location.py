"""Choose learning data independently from installation files and remember that choice."""

import json
import os
import shutil
import sqlite3
import stat
import tempfile
from contextlib import closing, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from app import config
from app.config import ServerSettings, Settings
from app.db import sqlite_file_uri
from app.platform_io import is_link_or_reparse, make_private_directory

_PERMISSION_HINT = "请检查数据目录的访问权限，或选择可写的数据目录。也可能是安全软件阻止了访问。"


class DataLocationError(ValueError):
    """A selected location or its persisted pointer cannot safely be used."""


@dataclass(frozen=True)
class LocationStatus:
    settings: Settings | None
    needs_selection: bool
    recovery: bool
    selected_path: Path | None
    default_path: Path
    error: str | None = None
    source: str = "default"
    warning: str | None = None
    server: ServerSettings | None = None
    failure: Exception | None = None
    database_existed: bool | None = None


class _FileSelectionStore:
    @property
    def path(self) -> Path:
        return config.selection_record_paths()[0]

    def read(self) -> str | None:
        for path in config.selection_record_paths():
            try:
                with path.open("r", encoding="utf-8") as stream:
                    payload: object = json.load(stream)
                break
            except FileNotFoundError:
                if path.is_symlink():
                    raise DataLocationError(
                        f"无法打开已记住的数据位置，位置记录的链接已失效：{path}"
                    ) from None
            except (UnicodeError, json.JSONDecodeError) as exc:
                raise DataLocationError(
                    f"无法读取数据位置记录：{path}。请使用「打开已有数据」重新选择。"
                ) from exc
        else:
            return None
        if not isinstance(payload, dict):
            raise DataLocationError(
                f"无法识别数据位置记录：{path}。请使用「打开已有数据」重新选择。"
            )
        value = cast(dict[str, object], payload).get("database_path")
        if not isinstance(value, str):
            raise DataLocationError(
                f"数据位置记录缺少数据库文件路径：{path}。请使用「打开已有数据」重新选择。"
            )
        return value

    def write(self, database_path: str) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, name = tempfile.mkstemp(prefix=".data-location-", dir=self.path.parent)
        temporary = Path(name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump({"database_path": database_path}, stream, ensure_ascii=False)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            with suppress(OSError):
                temporary.unlink(missing_ok=True)


def read_selection() -> Path | None:
    """Read a pointer without creating files or falling back from a damaged record."""
    try:
        value = _FileSelectionStore().read()
    except OSError as exc:
        raise DataLocationError(
            f"无法读取已记住的数据位置：{exc.filename or '用户数据位置记录'}。{_PERMISSION_HINT}"
        ) from exc
    if value is None:
        return None
    path = Path(value).expanduser()
    if not value.strip() or not path.is_absolute():
        raise DataLocationError("已记住的数据库文件路径不完整，请使用「打开已有数据」重新选择。")
    return path


def location_status(config_path: Path | None = None) -> LocationStatus:
    """Inspect startup choices without creating a directory, pointer, or database."""
    default = config.default_database_path()
    selected: Path | None = None
    source = "configuration"
    server: ServerSettings | None = None
    warning: str | None = None
    try:
        if "FOLIO_J_DATABASE_PATH" not in os.environ:
            source = "remembered"
            selected = read_selection()
            if selected is None:
                source = "configuration"
        resolution = config.resolve_settings(config_path, remembered_path=selected)
        settings, source = resolution.settings, resolution.source
        server, warning = settings.server, resolution.warning
        selected = settings.database.path
        exists = config.database_exists(selected)
        if exists:
            validate_library_identity(selected)
        needs_selection = source == "default" and not exists
        return LocationStatus(
            settings=None if needs_selection else settings,
            needs_selection=needs_selection,
            recovery=False,
            selected_path=None if needs_selection else selected,
            default_path=default,
            source=source,
            warning=resolution.warning,
            server=server,
            database_existed=exists,
        )
    except (ValueError, OSError, RuntimeError) as exc:
        if isinstance(exc, config.DatabaseLocationError):
            resolution = exc.resolution
            selected = resolution.settings.database.path
            server, warning = resolution.settings.server, resolution.warning
            source = resolution.source
        message = "无法检查学习数据位置。请核对配置、路径和文件访问权限后重试。"
        if isinstance(exc, OSError):
            message = (
                f"无法访问配置或数据位置：{exc.filename or selected or default}。{_PERMISSION_HINT}"
            )
        elif isinstance(
            exc,
            (
                DataLocationError,
                config.DatabaseLocationError,
                config.DatabasePathError,
                config.SettingsAccessError,
                config.SettingsFormatError,
            ),
        ):
            message = str(exc)
        return LocationStatus(
            settings=None,
            needs_selection=False,
            recovery=True,
            selected_path=selected,
            default_path=default,
            error=message,
            source=source,
            warning=warning,
            server=server,
            failure=exc,
        )


def _library_identity(database: Path, *, immutable: bool) -> str | None:
    uri = f"{sqlite_file_uri(database.as_uri())}?mode=ro"
    if immutable:
        uri += "&immutable=1"
    with closing(sqlite3.connect(uri, uri=True)) as connection:
        tables = {
            str(row[0])
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        if not {"alembic_version", "sources", "materials", "segments"}.issubset(tables):
            return "schema"
        versions = connection.execute("SELECT version_num FROM alembic_version").fetchall()
        if not versions or not all(isinstance(row[0], str) and row[0] for row in versions):
            return "version"
    return None


def _file_revision(info: os.stat_result) -> tuple[int, int, int, int, int]:
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def _library_identity_with_wal(path: Path, wal: Path) -> str | None:
    """Let SQLite read committed WAL transactions against a private copy."""
    files = [path, wal]
    before = [_file_revision(file.stat()) for file in files]
    with tempfile.TemporaryDirectory(prefix="folio-j-library-check-") as directory:
        copy = Path(directory) / "app.db"
        shutil.copyfile(path, copy)
        shutil.copyfile(wal, Path(f"{copy}-wal"))
        if before != [_file_revision(file.stat()) for file in files]:
            raise DataLocationError(
                f"检查时数据库文件正在变化：{path}。请关闭正在写入该文件的程序后重试。"
            )
        return _library_identity(copy, immutable=False)


def validate_library_identity(path: Path) -> None:
    """Recognize a learning library without letting SQLite write beside it."""
    try:
        wal = Path(f"{path}-wal")
        try:
            wal_info = wal.lstat()
        except FileNotFoundError:
            wal_info = None
        if wal_info is not None and (not stat.S_ISREG(wal_info.st_mode) or is_link_or_reparse(wal)):
            raise DataLocationError(f"数据库的 WAL 文件无法安全读取：{wal}")
        # The first 32 bytes of a WAL are its header. Only a WAL with
        # additional bytes could carry database pages missing from the main file.
        if wal_info is not None and wal_info.st_size > 32:
            problem = _library_identity_with_wal(path, wal)
        else:
            problem = _library_identity(path, immutable=True)
    except (sqlite3.Error, OSError) as exc:
        raise DataLocationError(
            f"无法读取 Folio-J 数据库文件：{path}。请检查文件和访问权限。"
            "也可能是安全软件阻止了访问。"
        ) from exc
    if problem == "schema":
        raise DataLocationError(
            f"无法识别所选的 Folio-J 数据库文件：{path}。请选择由 Folio-J 创建的数据库文件。"
        )
    if problem == "version":
        raise DataLocationError(
            f"所选数据库文件缺少版本信息：{path}。请选择另一份数据或从备份恢复。"
        )


def require_new_database_path(path: Path) -> None:
    """Accept an unused name, including a harmless worker lock from a previous attempt."""
    try:
        path.lstat()
    except FileNotFoundError:
        pass
    else:
        raise DataLocationError(
            f"该位置已有数据库文件：{path}。请选择「打开已有数据」，或选择其他数据目录。"
        )
    for suffix in config.DATABASE_COMPANIONS:
        companion = Path(f"{path}{suffix}")
        try:
            companion_info = companion.lstat()
        except FileNotFoundError:
            continue
        if (
            suffix != ".worker.lock"
            or not stat.S_ISREG(companion_info.st_mode)
            or companion_info.st_nlink != 1
            or is_link_or_reparse(companion)
        ):
            raise DataLocationError(
                f"所选位置仅剩数据库配套文件，或锁文件异常：{companion}。请核对路径或从备份恢复。"
            )


def _validate_writable(path: Path, *, use_existing: bool) -> None:
    if not use_existing:
        require_new_database_path(path)
    elif not config.database_exists(path):
        raise DataLocationError(
            f"找不到数据库文件：{path}。请选择原数据库文件或包含 app.db 的数据目录。"
        )
    _check_writable(path, exists=use_existing, create_directory=True)


def _check_writable(path: Path, *, exists: bool, create_directory: bool) -> None:
    try:
        if exists:
            if os.name != "nt" and not path.stat().st_mode & (
                stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH
            ):
                raise PermissionError(f"数据库文件不可写：{path}")
            with path.open("r+b") as stream:
                if stream.read(16) != b"SQLite format 3\x00":
                    raise DataLocationError(
                        f"所选文件不是可读取的数据库文件：{path}。"
                        "请选择由 Folio-J 创建的数据库文件。"
                    )
            validate_library_identity(path)
        if create_directory:
            make_private_directory(path.parent, parents=True, exist_ok=True)
        if os.name != "nt" and not path.parent.stat().st_mode & (
            stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH
        ):
            raise PermissionError(f"数据目录不可写：{path.parent}")
        descriptor, name = tempfile.mkstemp(prefix=".folio-j-write-check-", dir=path.parent)
        os.close(descriptor)
        Path(name).unlink()
    except OSError as exc:
        raise DataLocationError(
            f"无法写入数据目录或数据库文件：{path.parent}。{_PERMISSION_HINT}"
        ) from exc


def prepare_selection(directory: Path, use_existing: bool = False) -> Settings:
    """Validate an explicit choice; never migrate, overwrite, or remember a database."""
    return prepare_selection_resolution(directory, use_existing).settings


def prepare_selection_resolution(
    directory: Path, use_existing: bool = False
) -> config.SettingsResolution:
    if "FOLIO_J_DATABASE_PATH" in os.environ:
        raise DataLocationError(
            "当前数据库文件由环境变量 FOLIO_J_DATABASE_PATH 指定。"
            "请先修改或移除该变量，再选择数据位置。"
        )
    chosen = directory.expanduser()
    if not chosen.is_absolute():
        raise DataLocationError("请填写数据目录或数据库文件的完整路径。")
    try:
        path = chosen if use_existing and chosen.is_file() else chosen / "app.db"
        if not use_existing and is_link_or_reparse(path):
            raise DataLocationError(f"新数据库的目标名称已被链接占用：{path}。请选择其他目录。")
        path = path.resolve()
    except PermissionError as exc:
        raise DataLocationError(
            f"无法访问所选数据位置：{exc.filename or chosen}。{_PERMISSION_HINT}"
        ) from exc
    resolution = config.resolve_settings(selected_path=path)
    _validate_writable(path, use_existing=use_existing)
    return resolution


def validate_retry_selection(settings: Settings) -> Settings:
    """Recheck the canonical path, its file type and any companions before retrying."""
    path = settings.database.path
    try:
        if not path.is_absolute() or path.resolve() != path:
            raise DataLocationError(f"之前选择的路径已改变：{path}。请重新选择数据位置。")
        if is_link_or_reparse(path) or is_link_or_reparse(path.parent):
            raise DataLocationError(f"数据位置不能是符号链接或系统重解析点：{path}。请重新选择。")
        parent_info = path.parent.stat()
        if not stat.S_ISDIR(parent_info.st_mode):
            raise DataLocationError(f"所选路径不再是目录：{path.parent}。请选择其他数据目录。")
        try:
            info = path.lstat()
        except FileNotFoundError:
            info = None
        if info is not None:
            if not stat.S_ISREG(info.st_mode):
                raise DataLocationError(
                    f"之前选择的数据库文件已失效：{path}。请选择另一份数据或从备份恢复。"
                )
            _check_writable(path, exists=True, create_directory=False)
            return settings
        require_new_database_path(path)
        _check_writable(path, exists=False, create_directory=False)
        return settings
    except FileNotFoundError as exc:
        raise DataLocationError(
            f"之前选择的数据目录已不存在：{path.parent}。请重新连接原位置或选择其他数据目录。"
        ) from exc
    except OSError as exc:
        raise DataLocationError(f"无法访问之前选择的数据位置：{path}。{_PERMISSION_HINT}") from exc
    except RuntimeError as exc:
        raise DataLocationError(f"无法打开数据位置的链接：{path}。请重新选择数据位置。") from exc


def remember_selection(database_path: Path) -> None:
    """Persist only a successfully started learning database; callers migrate first."""
    if not database_path.is_absolute():
        raise DataLocationError("无法记住数据位置，数据库文件路径不完整。")
    if not config.database_exists(database_path):
        raise DataLocationError(f"数据库文件尚未创建，无法记住数据位置：{database_path}")
    validate_library_identity(database_path)
    store = _FileSelectionStore()
    try:
        store.write(str(database_path.resolve()))
    except OSError as exc:
        raise DataLocationError(
            f"无法写入数据位置记录：{store.path}。请检查应用配置目录的写入权限。"
            "也可能是安全软件阻止了访问。"
        ) from exc
