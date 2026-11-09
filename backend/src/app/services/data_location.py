"""Choose learning data independently from installation files and remember that choice."""

import importlib
import json
import os
import sqlite3
import stat
import sys
import tempfile
from contextlib import AbstractContextManager, closing, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, cast

from app import config
from app.config import ServerSettings, Settings
from app.platform_io import is_link_or_reparse

_PERMISSION_HINT = "请核对目录访问权限，或选择可写目录；也可能是安全软件拦截了程序访问。"
_REGISTRY_KEY = r"Software\Folio-J"
_REGISTRY_VALUE = "DatabasePath"


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


class _SelectionStore(Protocol):
    def read(self) -> str | None: ...
    def write(self, database_path: str) -> None: ...


class _Registry(Protocol):
    HKEY_CURRENT_USER: int
    KEY_READ: int
    KEY_SET_VALUE: int
    REG_SZ: int

    def OpenKey(
        self, key: int, sub_key: str, reserved: int, access: int
    ) -> AbstractContextManager[object]: ...
    def CreateKeyEx(
        self, key: int, sub_key: str, reserved: int, access: int
    ) -> AbstractContextManager[object]: ...
    def QueryValueEx(self, key: object, value_name: str) -> tuple[object, int]: ...
    def SetValueEx(
        self, key: object, value_name: str, reserved: int, value_type: int, value: str
    ) -> None: ...


def _registry_adapter() -> _Registry:
    return cast(_Registry, importlib.import_module("winreg"))


class _RegistrySelectionStore:
    def read(self) -> str | None:
        registry = _registry_adapter()
        try:
            with registry.OpenKey(
                registry.HKEY_CURRENT_USER, _REGISTRY_KEY, 0, registry.KEY_READ
            ) as key:
                value, value_type = registry.QueryValueEx(key, _REGISTRY_VALUE)
        except FileNotFoundError:
            return None
        if value_type != registry.REG_SZ or not isinstance(value, str):
            raise DataLocationError("已记住的数据位置记录无效，请重新选择已有学习库。")
        return value

    def write(self, database_path: str) -> None:
        registry = _registry_adapter()
        with registry.CreateKeyEx(
            registry.HKEY_CURRENT_USER, _REGISTRY_KEY, 0, registry.KEY_SET_VALUE
        ) as key:
            registry.SetValueEx(key, _REGISTRY_VALUE, 0, registry.REG_SZ, database_path)


class _FileSelectionStore:
    @property
    def path(self) -> Path:
        config_home = os.environ.get("XDG_CONFIG_HOME")
        root = Path(config_home) if config_home else Path.home() / ".config"
        if not root.is_absolute():
            root = Path.home() / ".config"
        return root / "folio-j" / "data-location.json"

    def read(self) -> str | None:
        try:
            with self.path.open("r", encoding="utf-8") as stream:
                payload: object = json.load(stream)
        except FileNotFoundError:
            if self.path.is_symlink():
                raise DataLocationError(f"数据位置记录的链接已失效：{self.path}") from None
            return None
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise DataLocationError(
                f"数据位置记录无法读取：{self.path}。请重新选择已有学习库。"
            ) from exc
        if not isinstance(payload, dict):
            raise DataLocationError(f"数据位置记录无效：{self.path}")
        value = cast(dict[str, object], payload).get("database_path")
        if not isinstance(value, str):
            raise DataLocationError(f"数据位置记录缺少数据库路径：{self.path}")
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


def _selection_store() -> _SelectionStore:
    return _RegistrySelectionStore() if sys.platform == "win32" else _FileSelectionStore()


def read_selection() -> Path | None:
    """Read a pointer without creating files or falling back from a damaged record."""
    try:
        value = _selection_store().read()
    except OSError as exc:
        raise DataLocationError(
            f"无法读取已记住的数据位置：{exc.filename or '用户数据位置记录'}。{_PERMISSION_HINT}"
        ) from exc
    if value is None:
        return None
    path = Path(value).expanduser()
    if not value.strip() or not path.is_absolute():
        raise DataLocationError("已记住的数据库路径必须是绝对路径，请重新选择已有学习库。")
    return path


def location_status(config_path: Path | None = None) -> LocationStatus:
    """Inspect startup choices without creating a directory, pointer, or database."""
    default = config.USER_DIRECTORY.expanduser() / "app.db"
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
            _validate_library_identity(selected)
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
        )
    except (ValueError, OSError) as exc:
        if isinstance(exc, config.DatabaseLocationError):
            resolution = exc.resolution
            selected = resolution.settings.database.path
            server, warning = resolution.settings.server, resolution.warning
            source = resolution.source
        message = str(exc)
        if isinstance(exc, OSError):
            message = (
                f"无法访问配置或数据位置：{exc.filename or selected or default}。{_PERMISSION_HINT}"
            )
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
        )


def _validate_library_identity(path: Path) -> None:
    """Read an immutable snapshot, so even an unrelated SQLite gains no sidecars."""
    try:
        with closing(
            sqlite3.connect(f"{path.as_uri()}?mode=ro&immutable=1", uri=True)
        ) as connection:
            tables = {
                str(row[0])
                for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
            }
            required = {"alembic_version", "sources", "materials", "segments"}
            if not required.issubset(tables):
                raise DataLocationError(f"所选数据库不是可识别的 Folio-J 学习库：{path}。")
            versions = connection.execute("SELECT version_num FROM alembic_version").fetchall()
            if not versions or not all(isinstance(row[0], str) and row[0] for row in versions):
                raise DataLocationError(f"所选学习库缺少迁移版本记录：{path}。")
    except sqlite3.Error as exc:
        raise DataLocationError(
            f"无法读取 Folio-J 学习库：{path}。请核对库文件与访问权限；"
            "也可能是安全软件拦截了程序访问。"
        ) from exc


def _validate_writable(path: Path, *, use_existing: bool) -> None:
    exists = config.database_exists(path)
    if use_existing and not exists:
        raise DataLocationError(
            f"找不到已有学习库：{path}。请选择包含原 app.db 的目录或数据库文件。"
        )
    if not use_existing and exists:
        raise DataLocationError(
            f"该位置已有学习库：{path}。请选择“打开已有学习库”，或选择其他目录。"
        )
    _check_writable(path, exists=exists, create_directory=True)


def _check_writable(path: Path, *, exists: bool, create_directory: bool) -> None:
    try:
        if exists:
            if os.name != "nt" and not path.stat().st_mode & (
                stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH
            ):
                raise PermissionError(f"数据库文件不可写：{path}")
            with path.open("r+b") as stream:
                if stream.read(16) != b"SQLite format 3\x00":
                    raise DataLocationError(f"所选文件不是可识别的 SQLite 学习库：{path}。")
            _validate_library_identity(path)
        if create_directory:
            path.parent.mkdir(parents=True, exist_ok=True)
        if os.name != "nt" and not path.parent.stat().st_mode & (
            stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH
        ):
            raise PermissionError(f"数据目录不可写：{path.parent}")
        descriptor, name = tempfile.mkstemp(prefix=".folio-j-write-check-", dir=path.parent)
        os.close(descriptor)
        Path(name).unlink()
    except OSError as exc:
        raise DataLocationError(
            f"数据目录或数据库不可写：{path.parent}。{_PERMISSION_HINT}"
        ) from exc


def prepare_selection(directory: Path, use_existing: bool = False) -> Settings:
    """Validate an explicit choice; never migrate, overwrite, or remember a database."""
    if "FOLIO_J_DATABASE_PATH" in os.environ:
        raise DataLocationError(
            "当前 FOLIO_J_DATABASE_PATH 环境变量指定了数据库；"
            "请先修改或移除该变量，再选择数据位置。"
        )
    chosen = directory.expanduser()
    if not chosen.is_absolute():
        raise DataLocationError("数据位置需要填写绝对路径。")
    try:
        path = chosen if use_existing and chosen.is_file() else chosen / "app.db"
        path = path.resolve()
    except PermissionError as exc:
        raise DataLocationError(
            f"无法访问所选数据位置：{exc.filename or chosen}。{_PERMISSION_HINT}"
        ) from exc
    resolution = config.resolve_settings(selected_path=path)
    _validate_writable(path, use_existing=use_existing)
    return resolution.settings


def validate_retry_selection(settings: Settings) -> Settings:
    """Recheck this session's prepared candidate after the user explicitly retries it.

    The caller must retain the Settings from a successful prepare_selection call.
    Only that failed startup candidate may tolerate its own ordinary worker lock
    without a database. Other startup/config resolution remains strict.
    """
    path = settings.database.path
    try:
        if not path.is_absolute() or path.resolve() != path:
            raise DataLocationError(
                f"先前选择的数据位置已变为链接或路径发生变化：{path}。请重新选择。"
            )
        if is_link_or_reparse(path) or is_link_or_reparse(path.parent):
            raise DataLocationError(f"先前选择的数据位置不能是链接：{path}。请重新选择。")
        parent_info = path.parent.stat()
        if not stat.S_ISDIR(parent_info.st_mode):
            raise DataLocationError(f"先前选择的数据目录不再是目录：{path.parent}。")
        try:
            info = path.lstat()
        except FileNotFoundError:
            info = None
        if info is not None:
            if not stat.S_ISREG(info.st_mode):
                raise DataLocationError(f"先前选择的数据库不再是普通文件：{path}。")
            _check_writable(path, exists=True, create_directory=False)
            return settings
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
                    f"先前选择的位置仅剩配套文件或异常进程锁：{companion}。请核对路径或从备份恢复。"
                )
        _check_writable(path, exists=False, create_directory=False)
        return settings
    except FileNotFoundError as exc:
        raise DataLocationError(
            f"先前选择的数据目录已不存在：{path.parent}。请重新连接原位置或重新选择。"
        ) from exc
    except OSError as exc:
        raise DataLocationError(f"无法访问先前选择的数据位置：{path}。{_PERMISSION_HINT}") from exc
    except RuntimeError as exc:
        raise DataLocationError(f"先前选择的数据位置存在异常链接：{path}。请重新选择。") from exc


def remember_selection(database_path: Path) -> None:
    """Persist only a successfully started learning database; callers migrate first."""
    if not database_path.is_absolute():
        raise DataLocationError("需要使用数据库的绝对路径记住数据位置。")
    if not config.database_exists(database_path):
        raise DataLocationError(f"学习库尚未创建，无法记住数据位置：{database_path}")
    _validate_library_identity(database_path)
    try:
        _selection_store().write(str(database_path.resolve()))
    except OSError as exc:
        raise DataLocationError(
            f"学习库已就绪，但无法记住数据位置 {database_path}。"
            f"请核对用户配置记录的写入权限；也可能是安全软件拦截了程序访问。原因：{exc}"
        ) from exc
