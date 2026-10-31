"""Local application settings."""

import os
import tomllib
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

REPO_ROOT = Path(__file__).resolve().parents[3]
USER_DIRECTORY = Path("~/Folio-J-Data")


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


def _read_settings(path: Path) -> Settings:
    try:
        with path.open("rb") as stream:
            return Settings.model_validate(tomllib.load(stream))
    except FileNotFoundError:
        if path.is_symlink():
            raise ValueError(f"配置文件的链接已失效：{path}") from None
        return Settings()


def _database_exists(path: Path) -> bool:
    if path.is_file():
        return True
    companions = (
        "-wal",
        "-shm",
        ".worker.lock",
        ".secrets",
        ".dictionary.sqlite3",
        ".dictionary.sqlite3.library",
    )
    if os.path.lexists(path) or any(os.path.lexists(f"{path}{suffix}") for suffix in companions):
        raise ValueError(f"数据库路径不可用或仅剩配套文件：{path}。请核对路径或从备份恢复。")
    return False


def load_settings(config_path: Path | None = None) -> Settings:
    """Apply installation overrides to the user's settings before choosing a database."""
    user_file = USER_DIRECTORY.expanduser() / "app.toml"
    user = _read_settings(user_file)
    local = _read_settings(config_path or REPO_ROOT / "config" / "app.toml")
    fields = user.model_dump(exclude_unset=True)
    for section, values in local.model_dump(exclude_unset=True).items():
        fields.setdefault(section, {}).update(values)
    settings = Settings.model_validate(fields)

    override = os.environ.get("FOLIO_J_DATABASE_PATH")
    path = (Path(override) if override is not None else settings.database.path).expanduser()
    if override is None and "path" not in local.database.model_fields_set:
        if "path" in user.database.model_fields_set:
            if not path.is_absolute():
                raise ValueError(f"{user_file} 的 [database].path 需要填写绝对路径。")
        else:
            legacy = REPO_ROOT / "data" / "app.db"
            if _database_exists(legacy):
                path = legacy
    path = REPO_ROOT / path
    _database_exists(path)
    settings.database.path = path.resolve()
    return settings


if __name__ == "__main__":
    print(f"下次迁移和启动使用的数据库：{load_settings().database.path}")
    print(f"首次使用如需自选位置，请先在 {USER_DIRECTORY / 'app.toml'} 中设置 [database].path。")
