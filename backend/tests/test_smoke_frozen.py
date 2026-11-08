"""Keep the frozen smoke strict about resources and independent runtime checks."""

import importlib.util
import os
import shutil
from pathlib import Path
from types import ModuleType

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("smoke_frozen", ROOT / "scripts/smoke_frozen.py")
assert spec is not None and spec.loader is not None
smoke: ModuleType = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def write(root: Path, name: str, content: bytes = b"resource") -> Path:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


@pytest.fixture
def resources(tmp_path: Path) -> tuple[Path, Path]:
    repository = tmp_path / "repository"
    write(repository, "backend/prompts/chat/tools_v5.json", b'{"tools": []}')
    write(repository, "backend/prompts/context/events_v1.j2", b"{{ events }}")
    write(repository, "backend/alembic/env.py", b"# migration environment")
    write(repository, "backend/alembic/versions/0001_initial.py", b"revision = 'initial'")
    write(repository, "backend/alembic/__pycache__/env.pyc", b"do not distribute")
    package = tmp_path / "目录包 package"
    shutil.copytree(repository, package / "_internal")
    write(package / "_internal", "RELEASE.json", b'{"version": "test"}')
    return repository, package


@pytest.mark.parametrize(
    "missing",
    [
        "backend/prompts/chat/tools_v5.json",
        "backend/prompts/context/events_v1.j2",
        "backend/alembic/env.py",
        "backend/alembic/versions/0001_initial.py",
        "RELEASE.json",
    ],
)
def test_missing_frozen_resources_fail_before_application_start(
    resources: tuple[Path, Path], missing: str
) -> None:
    repository, package = resources
    smoke.check_resources(package, repository)
    (package / "_internal" / missing).unlink()
    with pytest.raises(RuntimeError, match="Missing"):
        smoke.check_resources(package, repository)


def test_stale_resource_cannot_pass_with_presence_alone(resources: tuple[Path, Path]) -> None:
    repository, package = resources
    write(package / "_internal", "backend/prompts/context/events_v1.j2", b"old template")
    with pytest.raises(RuntimeError, match="stale frozen resource"):
        smoke.check_resources(package, repository)


def test_child_isolation_removes_host_runtime_and_daily_data_configuration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for key, value in {
        "PATH": "/usr/local/bin:/usr/bin",
        "HOME": "/real/user",
        "PYTHONPATH": "/checkout/backend/src",
        "PYTHONHOME": "/real/python",
        "NODE_PATH": "/real/node_modules",
        "FOLIO_J_DATABASE_PATH": "/daily/app.db",
        "OPENAI_API_KEY": "never-inherit",
        "HTTPS_PROXY": "http://proxy.invalid",
        "SystemRoot": "C:/Windows",
    }.items():
        monkeypatch.setenv(key, value)
    database = tmp_path / "临时数据 data" / "app.db"
    environment = smoke.isolated_environment(tmp_path, database)
    assert environment["FOLIO_J_DATABASE_PATH"] == str(database)
    assert environment["HOME"] == environment["USERPROFILE"]
    assert Path(environment["HOME"]).is_relative_to(tmp_path)
    assert not database.exists()
    assert environment["SystemRoot"] == "C:/Windows"
    assert set(environment).isdisjoint(
        {"PYTHONPATH", "PYTHONHOME", "NODE_PATH", "OPENAI_API_KEY", "HTTPS_PROXY"}
    )
    assert Path(environment["PATH"]).is_relative_to(tmp_path)
    assert not list(Path(environment["PATH"]).iterdir())
    assert shutil.which("python", path=environment["PATH"]) is None
    assert shutil.which("node", path=environment["PATH"]) is None


def test_source_checkout_is_not_accepted_as_a_frozen_package(tmp_path: Path) -> None:
    binary = write(tmp_path, "Folio-J.exe" if os.name == "nt" else "Folio-J")
    with pytest.raises(ValueError, match="_internal"):
        smoke.executable(binary)
    (tmp_path / "_internal").mkdir()
    assert smoke.executable(tmp_path) == binary.resolve()
    assert smoke.executable(binary) == binary.resolve()


@pytest.mark.parametrize("failure", ["missing_js", "missing_css", "external_asset", "fallback"])
def test_frontend_check_catches_packaging_errors(
    monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    client = smoke.Client(8010)
    assets = '<script src="/assets/app.js"></script><link href="/assets/app.css">'
    if failure == "missing_js":
        assets = '<link href="/assets/app.css">'
    elif failure == "missing_css":
        assets = '<script src="/assets/app.js"></script>'
    elif failure == "external_asset":
        assets = assets.replace("/assets/app.js", "https://external.invalid/app.js")
    html = f"<html>{assets}</html>".encode()

    def get(path: str) -> bytes:
        if path in ("/", "/settings") or failure == "fallback":
            return html
        return b"built asset"

    monkeypatch.setattr(client, "get", get)
    with pytest.raises(RuntimeError, match="frontend|Frontend"):
        client.frontend()


def test_synthetic_provider_accepts_only_expected_sdk_routes_and_model() -> None:
    provider = smoke.SyntheticProvider()
    assert provider.response("GET", "/v1/models", {})["data"] == [{"id": smoke.SYNTHETIC_MODEL}]
    completion = provider.response(
        "POST",
        "/v1/chat/completions",
        {"model": smoke.SYNTHETIC_MODEL, "messages": [{"role": "user", "content": "test"}]},
    )
    assert completion["choices"][0]["message"]["content"] == smoke.SYNTHETIC_OUTPUT
    assert provider.response("GET", "/v1/models", {})["data"]
    response = provider.response(
        "POST", "/v1/responses", {"model": smoke.SYNTHETIC_MODEL, "input": "test"}
    )
    assert response["status"] == "completed"
    assert response["usage"]["total_tokens"] == 5
    provider.check_requests()
    with pytest.raises(ValueError, match="Unexpected"):
        provider.response("POST", "/v1/responses", {"model": "real-model", "input": "test"})
    with pytest.raises(RuntimeError, match="history"):
        provider.check_requests()


def test_run_check_rejects_extra_model_calls_and_requires_raw_response(tmp_path: Path) -> None:
    import sqlite3

    database = tmp_path / "isolated.db"
    saved = {"runs": [{"id": "synthetic-run"}]}
    with sqlite3.connect(database) as connection:
        connection.execute(
            "CREATE TABLE runs (id TEXT, purpose TEXT, status TEXT, "
            "output_text TEXT, raw_response TEXT)"
        )
        connection.execute(
            "INSERT INTO runs VALUES (?, ?, ?, ?, ?)",
            ("synthetic-run", "verification", "succeeded", smoke.SYNTHETIC_OUTPUT, "{}"),
        )
    smoke.check_database_runs(database, saved)
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE runs SET raw_response=NULL")
    with pytest.raises(RuntimeError, match="raw protocol response"):
        smoke.check_database_runs(database, saved)
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE runs SET raw_response='{}'")
        connection.execute("INSERT INTO runs VALUES ('extra', 'chat', 'succeeded', 'extra', '{}')")
    with pytest.raises(RuntimeError, match="Unexpected persisted"):
        smoke.check_database_runs(database, saved)
