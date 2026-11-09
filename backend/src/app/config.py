"""Local application settings."""

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from app.resources import installation_root

REPO_ROOT = installation_root()
USER_DIRECTORY = Path("~/Folio-J-Data")
DATABASE_COMPANIONS = (
    "-wal",
    "-shm",
    ".worker.lock",
    ".secrets",
    ".dictionary.sqlite3",
    ".dictionary.sqlite3.library",
)


class ServerSettings(BaseModel):
    host: Literal["127.0.0.1"] = "127.0.0.1"
    port: int = Field(default=8010, ge=1, le=65535)
    dev_port: int = Field(default=5187, ge=1, le=65535)


class DatabaseSettings(BaseModel):
    path: Path = USER_DIRECTORY / "app.db"


class TranslationLimits(BaseModel):
    """Provisional budgets; real-model translation quality has not been evaluated."""

    max_target_characters: int = Field(default=2000, ge=1, le=100000)
    max_context_characters: int = Field(default=2000, ge=0, le=100000)
    timeout_seconds: float = Field(default=120, gt=0, le=600)
    max_pending: int = Field(default=3, ge=1, le=100)
    default_max_output_tokens: int = Field(default=4000, ge=1, le=100000)


class Settings(BaseModel):
    translation: TranslationLimits = Field(default_factory=TranslationLimits)
    server: ServerSettings = Field(default_factory=ServerSettings)
    database: DatabaseSettings = Field(default_factory=DatabaseSettings)


class SettingsAccessError(ValueError):
    """A configuration file exists but cannot be read."""


def _read_settings(path: Path) -> Settings:
    try:
        with path.open("rb") as stream:
            return Settings.model_validate(tomllib.load(stream))
    except FileNotFoundError:
        if path.is_symlink():
            raise ValueError(f"配置文件的链接已失效：{path}") from None
        return Settings()
    except OSError as exc:
        raise SettingsAccessError(
            f"无法读取配置文件：{path}。请核对文件与所在目录的访问权限；"
            "也可能是安全软件拦截了程序访问。"
        ) from exc


def _path_present(path: Path) -> bool:
    try:
        path.lstat()
    except FileNotFoundError:
        return False
    except OSError as exc:
        raise ValueError(
            f"无法访问数据库或配套文件：{path}。请核对目录访问权限；"
            "也可能是安全软件拦截了程序访问。"
        ) from exc
    return True


def database_exists(path: Path) -> bool:
    try:
        if path.is_file():
            return True
        path.stat()
    except FileNotFoundError:
        pass
    except OSError as exc:
        raise ValueError(
            f"无法访问数据库：{path}。请核对文件与目录访问权限；也可能是安全软件拦截了程序访问。"
        ) from exc
    if _path_present(path) or any(
        _path_present(Path(f"{path}{suffix}")) for suffix in DATABASE_COMPANIONS
    ):
        raise ValueError(f"数据库路径不可用或仅剩配套文件：{path}。请核对路径或从备份恢复。")
    return False


@dataclass(frozen=True)
class SettingsResolution:
    settings: Settings
    source: str
    warning: str | None = None


class DatabaseLocationError(ValueError):
    """A resolved configuration whose database location needs recovery."""

    def __init__(self, resolution: SettingsResolution, message: str) -> None:
        super().__init__(message)
        self.resolution = resolution


def resolve_settings(
    config_path: Path | None = None,
    *,
    remembered_path: Path | None = None,
    selected_path: Path | None = None,
) -> SettingsResolution:
    """Resolve settings without creating directories, databases, or selection records."""
    user_file = USER_DIRECTORY.expanduser() / "app.toml"
    explicit_path = selected_path or remembered_path
    warning: str | None = None
    try:
        user = _read_settings(user_file)
    except SettingsAccessError:
        if explicit_path is None or explicit_path.parent == user_file.parent:
            raise
        user = Settings()
        warning = (
            f"无法读取旧配置 {user_file}；本次沿用所选学习库，"
            "旧配置中的端口与翻译限制已使用程序配置或默认值。"
        )
    local = _read_settings(config_path or REPO_ROOT / "config" / "app.toml")
    fields = user.model_dump(exclude_unset=True)
    for section, values in local.model_dump(exclude_unset=True).items():
        fields.setdefault(section, {}).update(values)
    settings = Settings.model_validate(fields)

    override = os.environ.get("FOLIO_J_DATABASE_PATH")
    if override is not None:
        path, source = Path(override), "environment"
    elif selected_path is not None:
        path, source = selected_path, "selection"
    elif remembered_path is not None:
        path, source = remembered_path, "remembered"
    elif "path" in local.database.model_fields_set:
        path, source = settings.database.path, "program"
    elif "path" in user.database.model_fields_set:
        path, source = settings.database.path.expanduser(), "user"
        if not path.is_absolute():
            raise ValueError(f"{user_file} 的 [database].path 需要填写绝对路径。")
    else:
        legacy = REPO_ROOT / "data" / "app.db"
        if database_exists(legacy):
            path, source = legacy, "legacy"
        else:
            path, source = settings.database.path, "default"
    path = REPO_ROOT / path.expanduser()
    settings.database.path = path.resolve()
    resolution = SettingsResolution(settings, source, warning)
    try:
        exists = database_exists(path)
        if source == "remembered" and not exists:
            raise ValueError(f"已记住的学习库不存在：{path}。请重新连接原位置或选择已有学习库。")
    except ValueError as exc:
        raise DatabaseLocationError(resolution, str(exc)) from exc
    return resolution


def load_settings(config_path: Path | None = None) -> Settings:
    """Apply environment, remembered selection, installation, and user settings."""
    from app.services.data_location import read_selection

    remembered = read_selection() if "FOLIO_J_DATABASE_PATH" not in os.environ else None
    return resolve_settings(config_path, remembered_path=remembered).settings


if __name__ == "__main__":
    print(f"下次迁移和启动使用的数据库：{load_settings().database.path}")
