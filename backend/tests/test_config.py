from pathlib import Path

import pytest
from pydantic import ValidationError

from app import config as app_config
from app.config import load_settings


@pytest.fixture(autouse=True)
def isolated_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    repo = tmp_path / "version-one"
    home.mkdir()
    repo.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(app_config, "REPO_ROOT", repo)
    monkeypatch.delenv("FOLIO_J_DATABASE_PATH", raising=False)


def write_config(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_default_config_without_file(tmp_path: Path) -> None:
    settings = load_settings(tmp_path / "missing.toml")
    assert settings.server.host == "127.0.0.1"
    assert settings.server.port == 8010
    assert settings.server.dev_port == 5187
    assert settings.database.path == Path.home() / "Folio-J-Data" / "app.db"
    assert not settings.database.path.exists()


def test_new_version_directory_reuses_persistent_config_and_database(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    persistent = Path.home() / "Folio-J-Data"
    write_config(persistent / "app.toml", "[server]\nport = 8021\n")
    (persistent / "app.db").write_bytes(b"existing learning data")
    before = load_settings()
    next_version = tmp_path / "version-two"
    next_version.mkdir()
    monkeypatch.setattr(app_config, "REPO_ROOT", next_version)
    after = load_settings()
    assert before.database.path == after.database.path == persistent / "app.db"
    assert before.server.port == after.server.port == 8021
    assert after.database.path.read_bytes() == b"existing learning data"


def test_program_config_overrides_individual_user_fields() -> None:
    database = Path.home() / "library" / "learning.db"
    write_config(
        Path.home() / "Folio-J-Data" / "app.toml",
        f'[server]\nport = 8021\ndev_port = 5199\n[database]\npath = "{database}"\n'
        "[translation]\nmax_pending = 7\ntimeout_seconds = 50\n",
    )
    write_config(
        app_config.REPO_ROOT / "config" / "app.toml",
        "[server]\nport = 8030\n[translation]\ntimeout_seconds = 60\n",
    )
    settings = load_settings()
    assert settings.database.path == database
    assert settings.server.port == 8030
    assert settings.server.dev_port == 5199
    assert settings.translation.max_pending == 7
    assert settings.translation.timeout_seconds == 60


def test_explicit_config_path_selects_program_layer(tmp_path: Path) -> None:
    write_config(Path.home() / "Folio-J-Data" / "app.toml", "[server]\ndev_port = 5199\n")
    write_config(app_config.REPO_ROOT / "config" / "app.toml", "[server]\nport = 8030\n")
    selected = tmp_path / "selected.toml"
    write_config(selected, "[server]\nport = 8040\n")
    settings = load_settings(selected)
    assert settings.server.port == 8040
    assert settings.server.dev_port == 5199


@pytest.mark.parametrize("database_path", ["/chosen/learning.db", "relative/learning.db"])
def test_database_path_environment_override(
    database_path: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(Path.home() / "Folio-J-Data" / "app.toml", '[database]\npath = "~/user.db"\n')
    write_config(app_config.REPO_ROOT / "config" / "app.toml", '[database]\npath = "program.db"\n')
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", database_path)
    settings = load_settings()
    expected = Path(database_path)
    if not expected.is_absolute():
        expected = app_config.REPO_ROOT / expected
    assert settings.database.path == expected


def test_repo_relative_database_path(tmp_path: Path) -> None:
    config = tmp_path / "app.toml"
    write_config(config, '[server]\nport = 8021\n[database]\npath = "data/test.db"\n')
    settings = load_settings(config)
    assert settings.server.port == 8021
    assert settings.database.path == app_config.REPO_ROOT / "data" / "test.db"


def test_user_database_path_expands_home() -> None:
    write_config(
        Path.home() / "Folio-J-Data" / "app.toml", '[database]\npath = "~/library/learning.db"\n'
    )
    assert load_settings().database.path == Path.home() / "library" / "learning.db"


def test_user_relative_database_path_rejected() -> None:
    write_config(
        Path.home() / "Folio-J-Data" / "app.toml", '[database]\npath = "data/learning.db"\n'
    )
    with pytest.raises(ValueError):
        load_settings()


def test_existing_repo_database_is_used_until_explicit_selection() -> None:
    legacy = app_config.REPO_ROOT / "data" / "app.db"
    legacy.parent.mkdir()
    legacy.write_bytes(b"legacy learning data")
    write_config(Path.home() / "Folio-J-Data" / "app.toml", "[server]\nport = 8021\n")
    assert load_settings().database.path == legacy
    assert legacy.read_bytes() == b"legacy learning data"
    write_config(Path.home() / "Folio-J-Data" / "app.toml", '[database]\npath = "~/chosen.db"\n')
    assert load_settings().database.path == Path.home() / "chosen.db"


@pytest.mark.parametrize(
    "suffix",
    [
        "-wal",
        "-shm",
        ".worker.lock",
        ".secrets",
        ".dictionary.sqlite3",
        ".dictionary.sqlite3.library",
    ],
)
def test_legacy_companion_without_database_rejected(suffix: str) -> None:
    legacy = app_config.REPO_ROOT / "data" / "app.db"
    legacy.parent.mkdir()
    companion = Path(str(legacy) + suffix)
    if suffix.endswith((".secrets", ".library")):
        companion.mkdir()
    else:
        companion.touch()
    with pytest.raises(ValueError):
        load_settings()
    assert not (Path.home() / "Folio-J-Data" / "app.db").exists()


def test_dangling_legacy_database_link_rejected(tmp_path: Path) -> None:
    legacy = app_config.REPO_ROOT / "data" / "app.db"
    legacy.parent.mkdir()
    legacy.symlink_to(tmp_path / "missing.db")
    with pytest.raises(ValueError):
        load_settings()


@pytest.mark.parametrize("location", ["default", "explicit"])
def test_missing_selected_database_with_companion_rejected(
    location: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = Path.home() / "Folio-J-Data" / "app.db"
    if location == "explicit":
        database = Path.home() / "restored.db"
        monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    database.parent.mkdir(parents=True, exist_ok=True)
    Path(str(database) + ".secrets").symlink_to(database.parent / "missing-secrets")
    with pytest.raises(ValueError):
        load_settings()
    assert not database.exists()


@pytest.mark.parametrize("field", ["port", "dev_port"])
@pytest.mark.parametrize("value", [0, 65536])
def test_server_ports_reject_unusable_values(tmp_path: Path, field: str, value: int) -> None:
    config = tmp_path / "app.toml"
    write_config(config, f"[server]\n{field} = {value}\n")
    with pytest.raises(ValidationError):
        load_settings(config)


def test_non_loopback_host_rejected(tmp_path: Path) -> None:
    config = tmp_path / "app.toml"
    write_config(config, '[server]\nhost = "0.0.0.0"\n')
    with pytest.raises(ValidationError):
        load_settings(config)
