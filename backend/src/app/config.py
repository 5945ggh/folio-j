"""Local application settings."""

import tomllib
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

REPO_ROOT = Path(__file__).resolve().parents[3]


class ServerSettings(BaseModel):
    host: Literal["127.0.0.1"] = "127.0.0.1"
    port: int = Field(default=8000, ge=1, le=65535)


class DatabaseSettings(BaseModel):
    path: Path = Path("data/app.db")


class Settings(BaseModel):
    server: ServerSettings = Field(default_factory=ServerSettings)
    database: DatabaseSettings = Field(default_factory=DatabaseSettings)


def load_settings(config_path: Path | None = None) -> Settings:
    """Load repo-local TOML, keeping usable defaults before config exists."""
    path = config_path if config_path is not None else REPO_ROOT / "config" / "app.toml"
    data = tomllib.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    settings = Settings.model_validate(data)
    database_path = settings.database.path
    if not database_path.is_absolute():
        database_path = REPO_ROOT / database_path
    return settings.model_copy(
        update={"database": settings.database.model_copy(update={"path": database_path})}
    )
