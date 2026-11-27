"""Startup selection, persistence failures, and compatibility stay off user storage."""

# Filesystem adapters are internal test seams.
# pyright: reportPrivateUsage=false

import json
import os
import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

from app import config
from app.services import data_location as locations


def database(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.execute("CREATE TABLE alembic_version (version_num TEXT)")
        connection.execute("INSERT INTO alembic_version VALUES ('0004_translation_reader_removal')")
        connection.execute("CREATE TABLE sources (id INTEGER)")
        connection.execute("CREATE TABLE materials (id INTEGER)")
        connection.execute("CREATE TABLE segments (id INTEGER)")
        connection.execute("CREATE TABLE retained_data (content TEXT)")
        connection.execute("INSERT INTO retained_data VALUES ('learning data')")
    return path


def config_file(path: Path, contents: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents, encoding="utf-8")


def test_first_launch_inspection_does_not_create_default_or_pointer() -> None:
    status = locations.location_status()
    assert status.needs_selection
    assert not status.recovery
    assert status.settings is None
    assert status.default_path == config.default_database_path()
    assert not status.default_path.parent.exists()
    assert not locations._FileSelectionStore().path.exists()
    assert config.load_settings().database.path == status.default_path
    assert not status.default_path.parent.exists()


@pytest.mark.parametrize("source", ["default", "legacy", "user", "program", "environment"])
def test_existing_locations_continue_without_selection(
    source: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    if source != "default":
        database(Path.home() / "Folio-J-Data" / "app.db")
    if source not in {"default", "legacy"}:
        database(config.REPO_ROOT / "data" / "app.db")
    if source == "default":
        path = database(config.default_database_path())
    elif source == "legacy":
        path = database(config.REPO_ROOT / "data" / "app.db")
    else:
        path = database(Path.home() / "original" / "app.db")
        if source in {"program", "environment"}:
            config_file(
                Path.home() / "Folio-J-Data" / "app.toml",
                '[database]\npath="~/lower-priority-user.db"\n',
            )
        if source == "environment":
            config_file(
                config.REPO_ROOT / "config" / "app.toml",
                '[database]\npath="lower-priority-program.db"\n',
            )
            monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(path))
        else:
            file = (
                Path.home() / "Folio-J-Data" / "app.toml"
                if source == "user"
                else config.REPO_ROOT / "config" / "app.toml"
            )
            config_file(file, f"[database]\npath={json.dumps(str(path))}\n")
    status = locations.location_status()
    assert not status.needs_selection
    assert not status.recovery
    assert status.settings is not None
    assert status.settings.database.path == path
    assert status.source == source
    assert not locations._FileSelectionStore().path.exists()


def test_unregistered_library_outside_fixed_candidates_is_not_discovered(tmp_path: Path) -> None:
    unregistered = database(tmp_path / "another-installation" / "data" / "app.db")
    before = unregistered.read_bytes()
    status = locations.location_status()
    assert status.needs_selection
    assert not status.recovery
    assert status.settings is None
    assert unregistered.read_bytes() == before
    assert not status.default_path.parent.exists()
    assert not locations._FileSelectionStore().path.exists()


def test_remembered_path_overrides_old_configs_and_survives_new_installation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    chosen = database(tmp_path / "chosen" / "app.db")
    locations.remember_selection(chosen)
    config_file(Path.home() / "Folio-J-Data" / "app.toml", '[database]\npath="~/old.db"\n')
    config_file(config.REPO_ROOT / "config" / "app.toml", '[database]\npath="old.db"\n')
    assert config.load_settings().database.path == chosen
    monkeypatch.setattr(config, "REPO_ROOT", tmp_path / "new-version")
    assert config.load_settings().database.path == chosen
    status = locations.location_status()
    assert status.source == "remembered"
    assert status.selected_path == chosen


def test_environment_has_priority_even_over_damaged_pointer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = locations._FileSelectionStore()
    store.path.parent.mkdir(parents=True)
    store.path.write_text("invalid json", encoding="utf-8")
    chosen = database(tmp_path / "environment" / "app.db")
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(chosen))
    assert config.load_settings().database.path == chosen
    assert not locations.location_status().recovery
    with pytest.raises(locations.DataLocationError, match="FOLIO_J_DATABASE_PATH"):
        locations.prepare_selection(tmp_path / "another")
    assert not (tmp_path / "another").exists()


@pytest.mark.parametrize("damaged", ["missing", "invalid", "relative", "empty"])
def test_bad_pointer_never_falls_back_or_creates_database(damaged: str) -> None:
    existing_default = database(Path.home() / "Folio-J-Data" / "app.db")
    before = existing_default.read_bytes()
    store = locations._FileSelectionStore()
    store.path.parent.mkdir(parents=True)
    if damaged == "missing":
        content = json.dumps({"database_path": str(Path.home() / "lost" / "app.db")})
    elif damaged == "invalid":
        content = "not json"
    else:
        content = json.dumps({"database_path": "relative/app.db" if damaged == "relative" else ""})
    store.path.write_text(content, encoding="utf-8")
    status = locations.location_status()
    assert status.recovery
    assert status.settings is None
    assert not status.needs_selection
    with pytest.raises(ValueError):
        config.load_settings()
    assert existing_default.read_bytes() == before
    assert not (Path.home() / "lost").exists()
    assert store.path.read_text(encoding="utf-8") == content


def test_unreadable_pointer_enters_recovery_without_using_existing_fallbacks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    chosen = database(tmp_path / "chosen" / "app.db")
    locations.remember_selection(chosen)
    pointer = locations._FileSelectionStore().path
    candidates = [
        pointer,
        chosen,
        database(Path.home() / "Folio-J-Data" / "app.db"),
        database(config.REPO_ROOT / "data" / "app.db"),
    ]
    before = {path: path.read_bytes() for path in candidates}
    original_open = Path.open

    def blocked_open(self: Path, *args: object, **kwargs: object) -> object:
        if self == pointer:
            raise PermissionError(13, "blocked pointer", str(pointer))
        return original_open(self, *args, **kwargs)  # type: ignore[arg-type]

    with monkeypatch.context() as blocked:
        blocked.setattr(Path, "open", blocked_open)
        status = locations.location_status()
        assert status.recovery
        assert not status.needs_selection
        assert status.settings is None
        assert status.source == "remembered"
        assert status.error is not None
        assert str(pointer) in status.error
        with pytest.raises(locations.DataLocationError, match="无法读取已记住"):
            config.load_settings()
    assert {path: path.read_bytes() for path in candidates} == before


def test_prepare_new_does_not_create_database_or_remember(tmp_path: Path) -> None:
    chosen = tmp_path / "可写学习库"
    settings = locations.prepare_selection(chosen)
    assert settings.database.path == chosen / "app.db"
    assert chosen.is_dir()
    assert list(chosen.iterdir()) == []
    assert locations.read_selection() is None
    with pytest.raises(locations.DataLocationError, match="尚未创建"):
        locations.remember_selection(settings.database.path)
    assert locations.read_selection() is None


def test_prepare_protects_existing_library_and_supports_explicit_open(tmp_path: Path) -> None:
    chosen = database(tmp_path / "existing" / "app.db")
    before = chosen.read_bytes()
    with pytest.raises(locations.DataLocationError, match="已有数据库文件"):
        locations.prepare_selection(chosen.parent)
    assert locations.prepare_selection(chosen.parent, use_existing=True).database.path == chosen
    assert locations.prepare_selection(chosen, use_existing=True).database.path == chosen
    assert chosen.read_bytes() == before
    assert locations.read_selection() is None


def test_existing_choice_must_exist_and_have_sqlite_header(tmp_path: Path) -> None:
    missing = tmp_path / "missing"
    with pytest.raises(locations.DataLocationError, match="找不到"):
        locations.prepare_selection(missing, use_existing=True)
    assert not missing.exists()
    invalid = tmp_path / "invalid" / "app.db"
    invalid.parent.mkdir()
    invalid.write_bytes(b"original non-database data")
    with pytest.raises(locations.DataLocationError, match="不是可读取的数据库文件"):
        locations.prepare_selection(invalid.parent, use_existing=True)
    assert invalid.read_bytes() == b"original non-database data"


def test_relative_selection_rejected_without_side_effects() -> None:
    with pytest.raises(locations.DataLocationError, match="完整路径"):
        locations.prepare_selection(Path("relative/library"))
    assert locations.read_selection() is None


def test_orphaned_companion_cannot_be_replaced_with_empty_database(tmp_path: Path) -> None:
    chosen = tmp_path / "orphaned"
    chosen.mkdir()
    companion = chosen / "app.db-wal"
    companion.write_bytes(b"retained wal")
    with pytest.raises(ValueError, match="配套文件"):
        locations.prepare_selection(chosen)
    assert companion.read_bytes() == b"retained wal"
    assert not (chosen / "app.db").exists()


def test_atomic_pointer_failure_keeps_previous_choice(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    previous = database(tmp_path / "previous" / "app.db")
    replacement = database(tmp_path / "replacement" / "app.db")
    locations.remember_selection(previous)
    pointer = locations._FileSelectionStore().path
    before = pointer.read_bytes()

    def blocked_replace(source: Path, destination: Path) -> None:
        raise PermissionError("security software may have blocked writing")

    monkeypatch.setattr(locations.os, "replace", blocked_replace)
    with pytest.raises(locations.DataLocationError, match="无法写入数据位置记录"):
        locations.remember_selection(replacement)
    assert pointer.read_bytes() == before
    assert list(pointer.parent.iterdir()) == [pointer]
    assert locations.read_selection() == previous


def test_permission_failure_explains_directory_and_does_not_create_database(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    directory = tmp_path / "blocked"

    def blocked_probe(*args: object, **kwargs: object) -> tuple[int, str]:
        raise PermissionError("denied")

    monkeypatch.setattr(locations.tempfile, "mkstemp", blocked_probe)
    with pytest.raises(locations.DataLocationError) as error:
        locations.prepare_selection(directory)
    assert str(directory) in str(error.value)
    assert "无法写入" in str(error.value)
    assert "可能是安全软件" in str(error.value)
    assert not (directory / "app.db").exists()
    assert locations.read_selection() is None


@pytest.mark.skipif(os.name == "nt", reason="POSIX mode bits; Windows write checks use actual I/O")
def test_readonly_database_is_rejected_without_changing_permissions(tmp_path: Path) -> None:
    path = database(tmp_path / "readonly" / "app.db")
    before = path.read_bytes()
    path.chmod(0o444)
    try:
        with pytest.raises(locations.DataLocationError, match="无法写入"):
            locations.prepare_selection(path.parent, use_existing=True)
        assert path.stat().st_mode & 0o777 == 0o444
        assert path.read_bytes() == before
    finally:
        path.chmod(0o600)


def test_unreadable_old_settings_only_bypassed_for_explicit_other_location(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    old_file = Path.home() / "Folio-J-Data" / "app.toml"
    original_open = Path.open

    def blocked_open(self: Path, *args: object, **kwargs: object) -> object:
        if self == old_file:
            raise PermissionError("blocked old user directory")
        return original_open(self, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(Path, "open", blocked_open)
    assert locations.location_status().recovery
    with pytest.raises(config.SettingsAccessError, match="无法读取配置"):
        config.load_settings()
    chosen = tmp_path / "outside"
    settings = locations.prepare_selection(chosen)
    database(settings.database.path)
    locations.remember_selection(settings.database.path)
    status = locations.location_status()
    assert not status.recovery
    assert status.settings is not None
    assert status.settings.database.path == settings.database.path
    assert status.warning is not None
    assert "旧配置" in status.warning
    assert "默认值" in status.warning


@pytest.mark.parametrize("config_home", ["default", "absolute", "relative"])
def test_selection_record_roundtrips_in_user_json(
    config_home: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    directory = (
        Path(os.environ["LOCALAPPDATA"]) / "Folio-J"
        if os.name == "nt"
        else Path.home() / ".config" / "folio-j"
    )
    if config_home == "absolute":
        directory = tmp_path / "xdg" / "folio-j"
        monkeypatch.setenv("XDG_CONFIG_HOME", str(directory.parent))
    elif config_home == "relative":
        monkeypatch.setenv("XDG_CONFIG_HOME", "relative")
    pointer = directory / "data-location.json"
    assert locations._FileSelectionStore().path == pointer
    assert locations.read_selection() is None
    assert not pointer.parent.exists()
    path = database(tmp_path / "所选学习库" / "app.db")
    locations.remember_selection(path)
    assert json.loads(pointer.read_text(encoding="utf-8")) == {"database_path": str(path)}
    assert locations.read_selection() == path
    assert config.load_settings().database.path == path
    assert locations.location_status().source == "remembered"


def test_unrelated_sqlite_is_rejected_without_schema_or_file_changes(tmp_path: Path) -> None:
    path = tmp_path / "unrelated" / "app.db"
    path.parent.mkdir()
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.execute("CREATE TABLE another_app (value TEXT)")
        connection.execute("INSERT INTO another_app VALUES ('retain')")
    before = path.read_bytes()
    with pytest.raises(locations.DataLocationError, match="无法识别所选的 Folio-J 数据库文件"):
        locations.prepare_selection(path.parent, use_existing=True)
    with pytest.raises(locations.DataLocationError, match="无法识别所选的 Folio-J 数据库文件"):
        locations.remember_selection(path)
    assert path.read_bytes() == before
    assert list(path.parent.iterdir()) == [path]
    assert locations.read_selection() is None


@pytest.mark.parametrize("damaged", ["missing", "invalid"])
def test_recovery_keeps_readable_server_configuration(tmp_path: Path, damaged: str) -> None:
    path = database(tmp_path / "chosen" / "app.db")
    locations.remember_selection(path)
    config_file(config.REPO_ROOT / "config" / "app.toml", "[server]\nport=8088\n")
    if damaged == "missing":
        path.unlink()
    else:
        path.write_bytes(b"invalid database")
    status = locations.location_status()
    assert status.recovery
    assert status.server is not None
    assert status.server.port == 8088
    assert status.selected_path == path
    assert status.source == "remembered"


def test_same_blocked_user_directory_cannot_bypass_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    old = Path.home() / "Folio-J-Data" / "app.toml"
    original = config._read_settings

    def read(path: Path) -> config.Settings:
        if path == old:
            raise config.SettingsAccessError("无法读取旧配置")
        return original(path)

    monkeypatch.setattr(config, "_read_settings", read)
    with pytest.raises(config.SettingsAccessError, match="无法读取旧配置"):
        locations.prepare_selection(old.parent)
    assert locations.read_selection() is None


def test_retry_prepared_candidate_allows_only_plain_worker_lock_and_keeps_migration_exclusive(
    tmp_path: Path,
) -> None:
    from app.launcher import migrate
    from app.platform_io import exclusive_file_lock

    settings = locations.prepare_selection(tmp_path / "candidate")
    path = settings.database.path
    lock = Path(f"{path}.worker.lock")
    lock.write_bytes(b"original worker lock")
    with pytest.raises(ValueError, match="配套文件"):
        config.database_exists(path)
    assert locations.prepare_selection(path.parent).database.path == path
    with exclusive_file_lock(lock):
        assert locations.validate_retry_selection(settings) is settings
        with pytest.raises(ValueError, match="无法使用数据库文件"):
            migrate(path)
        assert not path.exists()
    # Windows byte-range locks also exclude reads through another descriptor.
    assert lock.read_bytes() == b"original worker lock"
    assert locations.read_selection() is None
    migrate(path)
    assert locations.validate_retry_selection(settings) is settings
    assert lock.exists()
    assert locations.read_selection() is None


@pytest.mark.parametrize(
    "suffix",
    ["-wal", "-shm", ".secrets", ".dictionary.sqlite3", ".dictionary.sqlite3.library"],
)
def test_retry_prepared_candidate_rejects_other_orphaned_companions(
    tmp_path: Path, suffix: str
) -> None:
    settings = locations.prepare_selection(tmp_path / "candidate")
    path = settings.database.path
    lock = Path(f"{path}.worker.lock")
    lock.touch()
    companion = Path(f"{path}{suffix}")
    if suffix in {".secrets", ".dictionary.sqlite3.library"}:
        companion.mkdir()
    else:
        companion.write_bytes(b"retained companion")
    before = set(path.parent.iterdir())
    with pytest.raises(locations.DataLocationError, match="配套文件"):
        locations.validate_retry_selection(settings)
    assert set(path.parent.iterdir()) == before
    assert not path.exists()
    assert locations.read_selection() is None


def test_retry_rejects_unrelated_database_created_after_prepare(tmp_path: Path) -> None:
    settings = locations.prepare_selection(tmp_path / "candidate")
    path = settings.database.path
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.execute("CREATE TABLE unrelated_app (id INTEGER)")
    before = path.read_bytes()
    with pytest.raises(locations.DataLocationError, match="无法识别所选的 Folio-J 数据库文件"):
        locations.validate_retry_selection(settings)
    assert path.read_bytes() == before
    assert list(path.parent.iterdir()) == [path]
    assert locations.read_selection() is None


@pytest.mark.parametrize("kind", ["database", "lock", "directory"])
def test_retry_rejects_changed_links_without_following_or_recreating_data(
    tmp_path: Path, kind: str
) -> None:
    from support_paths import symlink_or_skip

    settings = locations.prepare_selection(tmp_path / "candidate")
    path = settings.database.path
    if kind == "directory":
        path.parent.rmdir()
        target = tmp_path / "different-location"
        target.mkdir()
        symlink_or_skip(path.parent, target, target_is_directory=True)
    else:
        target = tmp_path / "missing-target"
        symlink_or_skip(path if kind == "database" else Path(f"{path}.worker.lock"), target)
    with pytest.raises(locations.DataLocationError, match="路径已改变|锁文件异常"):
        locations.validate_retry_selection(settings)
    assert not target.joinpath("app.db").exists() if target.is_dir() else not target.exists()
    assert locations.read_selection() is None


def test_retry_missing_directory_does_not_recreate_it(tmp_path: Path) -> None:
    settings = locations.prepare_selection(tmp_path / "candidate")
    settings.database.path.parent.rmdir()
    with pytest.raises(locations.DataLocationError, match="已不存在"):
        locations.validate_retry_selection(settings)
    assert not settings.database.path.parent.exists()


def test_retry_permission_error_never_treated_as_missing_database(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = locations.prepare_selection(tmp_path / "candidate")
    path = settings.database.path
    lock = Path(f"{path}.worker.lock")
    lock.touch()
    original = Path.lstat

    def denied_lstat(self: Path) -> os.stat_result:
        if self == path:
            raise PermissionError("blocked candidate database")
        return original(self)

    monkeypatch.setattr(Path, "lstat", denied_lstat)
    with pytest.raises(locations.DataLocationError, match="无法访问之前选择"):
        locations.validate_retry_selection(settings)
    assert list(path.parent.iterdir()) == [lock]
    assert locations.read_selection() is None


def test_retry_rejects_nonregular_worker_lock(tmp_path: Path) -> None:
    settings = locations.prepare_selection(tmp_path / "candidate")
    lock = Path(f"{settings.database.path}.worker.lock")
    lock.mkdir()
    with pytest.raises(locations.DataLocationError, match="锁文件异常"):
        locations.validate_retry_selection(settings)
    assert lock.is_dir()
    assert not settings.database.path.exists()


@pytest.mark.parametrize("operation", ["is_file", "resolve"])
def test_prepare_path_permission_error_has_chinese_location_and_hint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    chosen = tmp_path / "blocked-parent" / "chosen"
    blocked = tmp_path / "blocked-parent"
    original = getattr(Path, operation)

    def denied(self: Path, *args: object, **kwargs: object) -> object:
        if self == chosen or self == chosen / "app.db":
            raise PermissionError(13, "Access is denied", str(blocked))
        return original(self, *args, **kwargs)

    monkeypatch.setattr(Path, operation, denied)
    with pytest.raises(locations.DataLocationError) as error:
        locations.prepare_selection(chosen, use_existing=operation == "is_file")
    assert "无法访问所选数据位置" in str(error.value)
    assert str(blocked) in str(error.value)
    assert "可能是安全软件" in str(error.value)
    assert isinstance(error.value.__cause__, PermissionError)
    assert not chosen.exists()
    assert locations.read_selection() is None


@pytest.mark.parametrize("local_value", ["absolute", "missing", "relative"])
def test_windows_new_paths_and_legacy_candidate_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, local_value: str
) -> None:
    monkeypatch.setattr(config, "_WINDOWS", True)
    if local_value == "absolute":
        local = tmp_path / "redirected app data"
        monkeypatch.setenv("LOCALAPPDATA", str(local))
    else:
        local = Path.home() / "AppData" / "Local"
        monkeypatch.delenv("LOCALAPPDATA")
        if local_value == "relative":
            monkeypatch.setenv("LOCALAPPDATA", "relative")
    app_dir = local / "Folio-J"
    old_home = Path.home() / "Folio-J-Data"
    fresh = locations.location_status()
    assert fresh.needs_selection and fresh.default_path == app_dir / "Data" / "app.db"
    assert locations._FileSelectionStore().path == app_dir / "data-location.json"
    assert not app_dir.exists()
    current = database(fresh.default_path)
    assert locations.location_status().selected_path == current
    old = database(old_home / "app.db")
    assert locations.location_status().selected_path == old
    program = database(config.REPO_ROOT / "data" / "app.db")
    assert locations.location_status().selected_path == program
    config_file(old_home / "app.toml", f"[database]\npath={json.dumps(str(old))}")
    assert locations.location_status().selected_path == old


def test_windows_reads_previous_record_in_place_and_prefers_new_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(config, "_WINDOWS", True)
    old_path = database(tmp_path / "custom" / "app.db")
    new_path = database(tmp_path / "another" / "app.db")
    current, prior = config.selection_record_paths()
    config_file(prior, json.dumps({"database_path": str(old_path)}))
    assert locations.location_status().selected_path == old_path
    assert not current.exists()
    locations.remember_selection(new_path)
    assert locations.location_status().selected_path == new_path
    assert json.loads(prior.read_text(encoding="utf-8"))["database_path"] == str(old_path)
    current.write_text("broken", encoding="utf-8")
    assert locations.location_status().recovery
    xdg = tmp_path / "isolated config"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(xdg))
    assert config.selection_record_paths() == (xdg / "folio-j" / "data-location.json",)
    assert locations.location_status().needs_selection


@pytest.mark.parametrize("mode", ["new", "existing"])
def test_pasted_path_is_normalized_before_constructing_path(mode: str) -> None:
    from app.services.startup import StartupSelection

    for directory in (r"D:\学习 数据", r"\\server\share\学习 数据"):
        selected = StartupSelection.model_validate(
            {"directory": f'  "{directory}"  ', "mode": mode}
        )
        assert selected.directory == directory
