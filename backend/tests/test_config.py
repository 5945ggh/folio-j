from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import REPO_ROOT, load_settings


def test_default_config_without_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FOLIO_J_DATABASE_PATH", raising=False)
    settings = load_settings(tmp_path / "missing.toml")
    assert settings.server.host == "127.0.0.1"
    assert settings.server.port == 8000
    assert settings.database.path == REPO_ROOT / "data" / "app.db"


def test_database_path_environment_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "isolated.db"
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    settings = load_settings(tmp_path / "missing.toml")
    assert settings.database.path == database


def test_repo_relative_database_path(tmp_path: Path) -> None:
    config = tmp_path / "app.toml"
    config.write_text(
        '[server]\nhost = "127.0.0.1"\nport = 8021\n[database]\npath = "data/test.db"\n',
        encoding="utf-8",
    )
    settings = load_settings(config)
    assert settings.server.port == 8021
    assert settings.database.path == REPO_ROOT / "data" / "test.db"


def test_non_loopback_host_rejected(tmp_path: Path) -> None:
    config = tmp_path / "app.toml"
    config.write_text('[server]\nhost = "0.0.0.0"\n', encoding="utf-8")
    with pytest.raises(ValidationError):
        load_settings(config)
