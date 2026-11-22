"""Protect the package smoke's clean setup and its evidence of a remembered library."""

import os
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import Mock, call
from zipfile import ZipFile

import pytest
import smoke_application as shared
import smoke_frozen as frozen_smoke
import smoke_source as source_smoke


class FirstLaunch(Exception):
    pass


def test_source_setup_and_first_launch_use_the_extracted_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive = tmp_path / "source.zip"
    with ZipFile(archive, "w") as package:
        package.writestr("发行包/config/app.example.toml", "")
    external = tmp_path / "caller-venv"
    monkeypatch.setenv("UV_PROJECT_ENVIRONMENT", str(external))
    monkeypatch.setenv("UV_CACHE_DIR", str(tmp_path / "shared-cache"))
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(tmp_path / "daily/app.db"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "daily-config"))
    recipes = Mock()
    launch = Mock(side_effect=FirstLaunch)
    monkeypatch.setattr(source_smoke, "run", recipes)
    monkeypatch.setattr(source_smoke, "check_first_run", launch)
    with pytest.raises(FirstLaunch):
        source_smoke.smoke(archive)

    launcher, source, environment, _, _ = launch.call_args.args
    assert recipes.call_args_list == [
        call(source, environment, "just", "setup"),
        call(source, environment, "just", "build"),
    ]
    venv = source / "backend/.venv"
    assert environment["UV_PROJECT_ENVIRONMENT"] == str(venv)
    python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    assert launcher == [str(python), "-m", "app.launcher"]
    assert environment["PATH"] == os.environ["PATH"]
    assert environment["UV_CACHE_DIR"] == os.environ["UV_CACHE_DIR"]
    assert "FOLIO_J_DATABASE_PATH" not in environment
    home = Path(environment["HOME"])
    assert home != Path.home() and environment["USERPROFILE"] == str(home)
    for key in ("XDG_CONFIG_HOME", "APPDATA", "LOCALAPPDATA"):
        assert Path(environment[key]).is_relative_to(home)
    assert os.environ["UV_PROJECT_ENVIRONMENT"] == str(external)


def test_frozen_uses_relocated_binary_before_explicit_path_migration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    binary = tmp_path / ("Folio-J.exe" if os.name == "nt" else "Folio-J")
    binary.touch()
    (tmp_path / "_internal").mkdir()
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(tmp_path / "daily/app.db"))
    monkeypatch.setattr(frozen_smoke, "check_resources", Mock())
    command = Mock()
    monkeypatch.setattr(frozen_smoke, "command", command)
    launch = Mock(side_effect=FirstLaunch)
    monkeypatch.setattr(frozen_smoke, "check_first_run", launch)
    with pytest.raises(FirstLaunch):
        frozen_smoke.smoke(binary)
    command.assert_not_called()
    launcher, _, environment, _, _ = launch.call_args.args
    assert len(launcher) == 1
    assert Path(launcher[0]).name == binary.name and Path(launcher[0]) != binary
    assert "FOLIO_J_DATABASE_PATH" not in environment


@pytest.mark.parametrize("failure", [None, "premature database", "wrong path", "missing data"])
def test_first_run_checks_selection_and_reads_the_same_data_after_restart(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str | None
) -> None:
    directory = tmp_path / "chosen"
    directory.mkdir()
    database = directory / "app.db"
    selected = {"ready": True, "selected_path": str(database.resolve())}
    source = {"id": "saved-source", "title": "首次选库 smoke"}
    first = Mock(origin="http://127.0.0.1:1234")
    first.get.return_value = b'<script nonce="test-token">'

    def select(path: str, *args: object, **kwargs: object) -> object:
        if path == "/_startup/state":
            return {"ready": False, "recovery": False, "selected_path": None}
        if path == "/_startup/select":
            assert args == ({"directory": str(directory), "mode": "new"},)
            assert kwargs == {
                "headers": {"Origin": first.origin, "X-Folio-Startup-Token": "test-token"}
            }
            database.touch(exist_ok=False)
            return selected
        assert path == "/api/sources"
        return source

    first.json.side_effect = select
    restart = Mock()
    restart.json.side_effect = [
        {**selected, "selected_path": str(tmp_path / "other.db")}
        if failure == "wrong path"
        else selected,
        {} if failure == "missing data" else source,
    ]
    application = Mock(side_effect=[nullcontext(first), nullcontext(restart)])
    monkeypatch.setattr(shared, "application", application)
    if failure == "premature database":
        database.touch()
    errors = {
        "premature database": "before selection",
        "wrong path": "did not remember",
        "missing data": "did not retain",
    }
    environment = {"HOME": str(tmp_path)}
    with pytest.raises(RuntimeError, match=errors[failure]) if failure else nullcontext():
        shared.check_first_run(["launcher"], tmp_path, environment, 1234, directory)
    if failure is None:
        assert application.call_args_list == [
            call(["launcher"], tmp_path, environment, 1234, selecting=True),
            call(["launcher"], tmp_path, environment, 1234),
        ]
        restart.json.assert_called_with("/api/sources/saved-source")
