"""Exercise selection and recovery through the same startup interface as the browser."""

import asyncio
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from app.config import DatabaseSettings, Settings
from app.services import data_location
from app.services.data_location import LocationStatus
from app.services.startup import StartupService
from app.startup import StartupApplication


def initial_status(tmp_path: Path, *, settings: Settings | None = None) -> LocationStatus:
    return LocationStatus(
        settings=settings,
        needs_selection=settings is None,
        recovery=False,
        selected_path=settings.database.path if settings is not None else None,
        default_path=tmp_path / "default/app.db",
        error=None,
        source="default",
        warning=None,
    )


@pytest.mark.asyncio
async def test_first_visit_is_read_only_and_selection_starts_same_server(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    events: list[str] = []

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
        events.append("start")
        yield
        events.append("close")

    main = FastAPI(lifespan=lifespan)

    @main.get("/")
    async def home() -> dict[str, str]:
        return {"page": "main"}

    def migrate(path: Path) -> None:
        assert path == tmp_path / "chosen/app.db"
        events.append("migrate")

    def remember(path: Path) -> None:
        assert events == ["migrate", "start"]
        events.append("remember")

    monkeypatch.setattr(data_location, "remember_selection", remember)
    service = StartupService(initial_status(tmp_path), migrate, lambda path: main)
    bootstrap = StartupApplication(service)
    await service.initialize()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=bootstrap), base_url="http://127.0.0.1:8010"
    ) as client:
        page = await client.get("/")
        assert "选择数据位置" in page.text
        assert "__FOLIO_STARTUP_NONCE__" not in page.text
        assert "no-store" in page.headers["cache-control"]
        assert (await client.get("/api/health")).status_code == 503
        assert not (tmp_path / "default").exists()
        assert events == []
        response = await client.post(
            "/_startup/select",
            json={"directory": str(tmp_path / "chosen"), "mode": "new"},
            headers={"Origin": "http://127.0.0.1:8010", "X-Folio-Startup-Token": service.token},
        )
        assert response.status_code == 200
        assert response.json()["ready"] is True
        assert (await client.get("/")).json() == {"page": "main"}
        assert events == ["migrate", "start", "remember"]
        rejected = await client.post(
            "/_startup/select",
            json={"directory": str(tmp_path / "another"), "mode": "new"},
            headers={"Origin": "http://127.0.0.1:8010", "X-Folio-Startup-Token": service.token},
        )
        assert rejected.status_code == 409
        assert not (tmp_path / "another").exists()
    await service.close()
    assert events == ["migrate", "start", "remember", "close"]


@pytest.mark.parametrize("failure", ["migration", "lifespan", "remember"])
@pytest.mark.asyncio
async def test_failure_keeps_page_recoverable_and_closes_application(
    failure: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.services.startup import StartupSelection

    events: list[str] = []
    failing = True

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
        events.append("start")
        try:
            if failing and failure == "lifespan":
                raise RuntimeError("lifespan failed")
            yield
        finally:
            events.append("close")

    def migrate(path: Path) -> None:
        if failing and failure == "migration":
            raise ValueError("migration failed")

    def remember(path: Path) -> None:
        events.append("remember")
        if failing and failure == "remember":
            raise OSError("remember failed")

    monkeypatch.setattr(data_location, "remember_selection", remember)
    service = StartupService(
        initial_status(tmp_path), migrate, lambda path: FastAPI(lifespan=lifespan)
    )
    state = await service.select(StartupSelection(directory=str(tmp_path / "chosen"), mode="new"))
    assert not state.ready
    assert state.recovery
    assert state.error == f"{failure} failed"
    assert events == (
        []
        if failure == "migration"
        else ["start", "close"]
        if failure == "lifespan"
        else ["start", "remember", "close"]
    )
    assert service.application is None

    # The first attempt may have created files; explicitly reopen that location.
    def prepare(directory: Path, use_existing: bool) -> Settings:
        return Settings(database=DatabaseSettings(path=tmp_path / "chosen/app.db"))

    monkeypatch.setattr(data_location, "prepare_selection", prepare)
    failing = False
    assert (
        await service.select(StartupSelection(directory=str(tmp_path / "chosen"), mode="existing"))
    ).ready
    await service.close()


@pytest.mark.asyncio
async def test_automatic_startup_failure_never_remembers_or_silently_creates_other_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    selected = tmp_path / "existing/app.db"
    settings = Settings(database=DatabaseSettings(path=selected))

    def migrate(path: Path) -> None:
        assert path == selected
        raise OSError("数据目录不可写")

    def remember(path: Path) -> None:
        pytest.fail("automatic startup must not remember a new location")

    monkeypatch.setattr(data_location, "remember_selection", remember)
    service = StartupService(
        initial_status(tmp_path, settings=settings), migrate, lambda path: FastAPI()
    )
    await service.initialize()
    assert service.state().recovery
    assert service.state().selected_path == str(selected)
    assert not (tmp_path / "default").exists()
    assert not selected.exists()
    await service.close()


@pytest.mark.parametrize(
    ("origin", "token", "host"),
    [
        (None, "valid", "127.0.0.1:8010"),
        ("http://evil.example", "valid", "127.0.0.1:8010"),
        ("http://127.0.0.1:8010", "wrong", "127.0.0.1:8010"),
        ("http://evil.example", "valid", "evil.example"),
    ],
)
@pytest.mark.asyncio
async def test_selection_rejects_cross_origin_missing_token_and_rebinding(
    origin: str | None, token: str, host: str, tmp_path: Path
) -> None:
    service = StartupService(initial_status(tmp_path), lambda path: None, lambda path: FastAPI())
    bootstrap = StartupApplication(service)
    headers = {"Host": host, "X-Folio-Startup-Token": service.token if token == "valid" else token}
    if origin is not None:
        headers["Origin"] = origin
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=bootstrap), base_url="http://127.0.0.1:8010"
    ) as client:
        response = await client.post(
            "/_startup/select",
            json={"directory": str(tmp_path / "chosen"), "mode": "new"},
            headers=headers,
        )
    assert response.status_code in (400, 403)
    assert not (tmp_path / "chosen").exists()


@pytest.mark.asyncio
async def test_retry_reloads_original_location_without_reselection_or_remembering(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "existing/app.db"
    settings = Settings(database=DatabaseSettings(path=path))
    status = initial_status(tmp_path, settings=settings)
    attempts: list[Path] = []

    def migrate(database: Path) -> None:
        attempts.append(database)
        if len(attempts) == 1:
            raise PermissionError("磁盘暂不可写")

    def forbidden_remember(database: Path) -> None:
        pytest.fail("Retry of the configured location must not remember a selection")

    monkeypatch.setattr(data_location, "location_status", lambda: status)
    monkeypatch.setattr(data_location, "remember_selection", forbidden_remember)
    service = StartupService(status, migrate, lambda database: FastAPI())
    await service.initialize()
    assert service.state().recovery
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=StartupApplication(service)),
        base_url="http://127.0.0.1:8010",
    ) as client:
        assert (await client.post("/_startup/retry")).status_code == 403
        response = await client.post(
            "/_startup/retry",
            headers={"Origin": "http://127.0.0.1:8010", "X-Folio-Startup-Token": service.token},
        )
        assert response.status_code == 200
        assert response.json()["ready"]
    assert attempts == [path, path]
    await service.close()


@pytest.mark.asyncio
async def test_real_application_lifespan_failure_releases_database_lock_and_can_reopen(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sqlalchemy.ext.asyncio import AsyncSession

    from app import main
    from app.launcher import migrate
    from app.platform_io import exclusive_file_lock
    from app.services.startup import StartupSelection

    first = True
    original = main.interrupt_unfinished

    async def fail_once(session: AsyncSession) -> None:
        nonlocal first
        if first:
            first = False
            raise RuntimeError("初始化中断，可重新打开原库")
        await original(session)

    def application(path: Path) -> FastAPI:
        app = main.create_app(database_path=path)
        app.state.chat_worker_enabled = False
        app.state.verification_worker_enabled = False
        return app

    monkeypatch.setattr(main, "interrupt_unfinished", fail_once)
    service = StartupService(initial_status(tmp_path), migrate, application)
    directory = tmp_path / "chosen"
    state = await service.select(StartupSelection(directory=str(directory), mode="new"))
    assert state.recovery
    assert state.error == "初始化中断，可重新打开原库"
    assert data_location.read_selection() is None
    lock = directory / "app.db.worker.lock"
    with exclusive_file_lock(lock):
        pass
    state = await service.select(StartupSelection(directory=str(directory), mode="existing"))
    assert state.ready
    assert data_location.read_selection() == directory / "app.db"
    await service.close()
    with exclusive_file_lock(lock):
        pass


@pytest.mark.asyncio
async def test_retry_current_recovers_new_candidate_with_only_worker_lock_and_keeps_lock_gate(
    tmp_path: Path,
) -> None:
    from app.launcher import migrate
    from app.platform_io import exclusive_file_lock
    from app.services.startup import StartupSelection

    first = True

    def fail_first(database: Path) -> None:
        nonlocal first
        if first:
            first = False
            with exclusive_file_lock(Path(f"{database}.worker.lock")):
                raise PermissionError("数据库写入被拒绝")
        migrate(database)

    service = StartupService(initial_status(tmp_path), fail_first, lambda path: FastAPI())
    directory = tmp_path / "chosen"
    state = await service.select(StartupSelection(directory=str(directory), mode="new"))
    assert state.retry_current_path == str(directory / "app.db")
    assert not (directory / "app.db").exists()
    assert data_location.read_selection() is None
    bootstrap = StartupApplication(service)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=bootstrap), base_url="http://127.0.0.1:8010"
    ) as client:
        assert (await client.post("/_startup/retry-current")).status_code == 403
        headers = {"Origin": "http://127.0.0.1:8010", "X-Folio-Startup-Token": service.token}
        with exclusive_file_lock(directory / "app.db.worker.lock"):
            rejected = await client.post("/_startup/retry-current", headers=headers)
            assert not rejected.json()["ready"]
            assert not (directory / "app.db").exists()
            assert data_location.read_selection() is None
        result = await client.post("/_startup/retry-current", headers=headers)
        assert result.json()["ready"]
        assert result.json()["retry_current_path"] is None
    assert data_location.read_selection() == directory / "app.db"
    assert (directory / "app.db.worker.lock").exists()
    await service.close()


@pytest.mark.asyncio
async def test_retry_current_recovers_explicit_environment_candidate_without_remembering(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.launcher import migrate
    from app.platform_io import exclusive_file_lock

    database = tmp_path / "explicit/app.db"
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    first = True

    def fail_first(path: Path) -> None:
        nonlocal first
        if first:
            first = False
            path.parent.mkdir()
            with exclusive_file_lock(Path(f"{path}.worker.lock")):
                raise PermissionError("初次环境配置目录写入被拒绝")
        migrate(path)

    service = StartupService(data_location.location_status(), fail_first, lambda path: FastAPI())
    await service.initialize()
    assert service.state().retry_current_path == str(database)
    assert not database.exists()
    # Fresh configuration resolution remains strict about an orphaned lock.
    assert data_location.location_status().settings is None
    assert (await service.retry_current()).ready
    assert data_location.read_selection() is None
    assert database.exists()
    await service.close()


@pytest.mark.asyncio
async def test_retry_current_does_not_recreate_previously_existing_database(
    tmp_path: Path,
) -> None:
    from app.launcher import migrate

    database = tmp_path / "existing/app.db"
    await asyncio.to_thread(migrate, database)

    def denied(path: Path) -> None:
        raise PermissionError("不可写")

    settings = Settings(database=DatabaseSettings(path=database))
    service = StartupService(
        initial_status(tmp_path, settings=settings), denied, lambda path: FastAPI()
    )
    await service.initialize()
    database.unlink()
    state = await service.retry_current()
    assert not state.ready
    assert state.error
    assert not database.exists()
    assert data_location.read_selection() is None
    await service.close()


@pytest.mark.asyncio
async def test_unconfirmed_first_choice_and_missing_remembered_location_have_no_retry_candidate(
    tmp_path: Path,
) -> None:
    from dataclasses import replace

    for status in (
        initial_status(tmp_path),
        replace(
            initial_status(tmp_path),
            recovery=True,
            source="remembered",
            selected_path=tmp_path / "missing/app.db",
            error="已记住的学习库不存在",
        ),
    ):
        service = StartupService(status, lambda path: None, lambda path: FastAPI())
        await service.initialize()
        assert service.state().retry_current_path is None
        with pytest.raises(ValueError, match="尚无已确认"):
            await service.retry_current()
        assert not (tmp_path / "missing").exists()
        await service.close()
