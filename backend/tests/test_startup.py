"""Exercise selection and recovery through the same startup interface as the browser."""

import asyncio
from collections.abc import AsyncGenerator, Generator
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from threading import Event

import httpx
import pytest
from fastapi import FastAPI

from app.config import DatabaseSettings, Settings, SettingsResolution
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
async def test_in_progress_stage_is_observable_and_reports_safe_nested_error(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    started, proceed = Event(), Event()
    secret = "credential-that-must-not-be-reported"

    def migrate(path: Path, require_existing: bool) -> None:
        assert not require_existing
        started.set()
        assert proceed.wait(5)
        denied = PermissionError(13, secret, None, 5)
        if getattr(denied, "winerror", None) is None:
            vars(denied)["winerror"] = 5
        raise data_location.DataLocationError("无法访问学习库。请检查权限。") from denied

    service = StartupService(initial_status(tmp_path), migrate, lambda path: FastAPI())
    headers = {"Origin": "http://127.0.0.1:8010", "X-Folio-Startup-Token": service.token}
    directory = tmp_path / "学习 数据"
    payload = {"directory": str(directory), "mode": "new"}
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=StartupApplication(service)),
        base_url="http://127.0.0.1:8010",
    ) as client:
        submission = asyncio.create_task(
            client.post("/_startup/select", headers=headers, json=payload)
        )
        try:
            assert await asyncio.to_thread(started.wait, 5)
            snapshot = await client.get("/_startup/state")
            assert snapshot.headers["cache-control"] == "no-store"
            state = snapshot.json()
            assert state["busy"] is True and state["ready"] is False
            assert state["stage"]["name"] == "迁移学习数据库"
            assert state["stage"]["target"] == str(directory / "app.db")
            assert state["stage"]["elapsed_ms"] >= 0
            for path in ("/_startup/select", "/_startup/retry", "/_startup/retry-current"):
                duplicate = await asyncio.wait_for(
                    client.post(path, headers=headers, json=payload), 1
                )
                assert duplicate.status_code == 409
        finally:
            proceed.set()
            response = await submission
        state = response.json()
        assert not state["busy"] and state["recovery"] and state["stage"] is None
        assert state == (await client.get("/_startup/state")).json()
    output = capsys.readouterr().err
    assert "启动阶段开始" in output
    assert "启动阶段失败：迁移学习数据库" in output
    assert "迁移学习数据库失败" in state["error"]
    for diagnostic in (state["error"], output):
        assert "PermissionError" in diagnostic
        assert "winerror=5" in diagnostic
        assert "请检查权限" in diagnostic
        assert secret not in diagnostic
    await service.close()


@pytest.mark.asyncio
async def test_state_remains_responsive_while_learning_application_opens_worker_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app import main
    from app.launcher import migrate

    started, proceed = Event(), Event()
    acquire = main.exclusive_file_lock

    @contextmanager
    def delayed_lock(path: Path) -> Generator[None, None, None]:
        started.set()
        assert proceed.wait(5)
        with acquire(path):
            yield

    monkeypatch.setattr(main, "exclusive_file_lock", delayed_lock)
    directory = tmp_path / "library"
    database = directory / "app.db"
    service = StartupService(
        initial_status(tmp_path),
        migrate,
        lambda path: main.create_app(database_path=path, require_existing=True),
    )
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=StartupApplication(service)),
            base_url="http://127.0.0.1:8010",
        ) as client:
            submission = asyncio.create_task(
                client.post(
                    "/_startup/select",
                    headers={
                        "Origin": "http://127.0.0.1:8010",
                        "X-Folio-Startup-Token": service.token,
                    },
                    json={"directory": str(directory), "mode": "new"},
                )
            )
            try:
                assert await asyncio.to_thread(started.wait, 5)
                response = await asyncio.wait_for(client.get("/_startup/state"), 2)
                state = response.json()
                assert state["busy"] and not state["ready"]
                assert state["stage"]["name"] == "初始化学习应用"
                assert state["stage"]["target"] == str(database)
            finally:
                proceed.set()
                response = await submission
            assert response.json()["ready"]
    finally:
        await service.close()
    with acquire(database.with_name("app.db.worker.lock")):
        pass


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

    def migrate(path: Path, require_existing: bool) -> None:
        assert path == tmp_path / "chosen/app.db"
        assert not require_existing
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
        assert "选择数据目录" in page.text
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

    def migrate(path: Path, require_existing: bool) -> None:
        if failing and failure == "migration":
            raise ValueError("migration failed")

    def remember(path: Path) -> None:
        events.append("remember")
        if failing and failure == "remember":
            raise RuntimeError("remember failed")

    monkeypatch.setattr(data_location, "remember_selection", remember)
    service = StartupService(
        initial_status(tmp_path), migrate, lambda path: FastAPI(lifespan=lifespan)
    )
    state = await service.select(StartupSelection(directory=str(tmp_path / "chosen"), mode="new"))
    assert not state.ready
    assert state.recovery
    assert state.error
    assert {
        "migration": "迁移学习数据库",
        "lifespan": "初始化学习应用",
        "remember": "保存数据位置记录",
    }[failure] in state.error
    assert f"{failure} failed" not in state.error
    assert events == (
        []
        if failure == "migration"
        else ["start", "close"]
        if failure == "lifespan"
        else ["start", "remember", "close"]
    )
    assert service.application is None

    # The first attempt may have created files; explicitly reopen that location.
    def prepare(directory: Path, use_existing: bool) -> SettingsResolution:
        return SettingsResolution(
            Settings(database=DatabaseSettings(path=tmp_path / "chosen/app.db")), "selection"
        )

    monkeypatch.setattr(data_location, "prepare_selection_resolution", prepare)
    failing = False
    assert (
        await service.select(StartupSelection(directory=str(tmp_path / "chosen"), mode="existing"))
    ).ready
    await service.close()


@pytest.mark.parametrize("error_type", [data_location.DataLocationError, OSError])
@pytest.mark.parametrize("previous_selection", [False, True])
@pytest.mark.asyncio
async def test_remember_failure_keeps_real_application_running_and_next_start_uses_saved_state(
    error_type: type[Exception],
    previous_selection: bool,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    from app import main
    from app.launcher import migrate
    from app.platform_io import FileLockError, exclusive_file_lock

    previous = tmp_path / "previous" / "app.db" if previous_selection else None
    if previous is not None:
        await asyncio.to_thread(migrate, previous)
        data_location.remember_selection(previous)

    def application(path: Path) -> FastAPI:
        app = main.create_app(database_path=path)
        app.state.chat_worker_enabled = False
        app.state.verification_worker_enabled = False
        return app

    def remember(path: Path) -> None:
        # Migration and the real lifespan must both have succeeded before persistence.
        assert path.is_file()
        with pytest.raises(FileLockError):
            with exclusive_file_lock(Path(f"{path}.worker.lock")):
                pass
        raise error_type("位置记录写入被拒绝")

    monkeypatch.setattr(data_location, "remember_selection", remember)
    service = StartupService(initial_status(tmp_path), migrate, application)
    directory = tmp_path / "chosen"
    path = directory / "app.db"
    bootstrap = StartupApplication(service)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=bootstrap), base_url="http://127.0.0.1:8010"
        ) as client:
            response = await client.post(
                "/_startup/select",
                json={"directory": str(directory), "mode": "new"},
                headers={
                    "Origin": "http://127.0.0.1:8010",
                    "X-Folio-Startup-Token": service.token,
                },
            )
            assert response.status_code == 200
            state = response.json()
            assert state["ready"] is True
            assert state["recovery"] is False
            assert state["error"] is None
            assert state["selected_path"] == str(path)
            assert state["retry_current_path"] is None
            assert "保存数据位置记录失败" in state["warning"]
            assert "下次" in state["warning"]
            assert state["warning"] in capsys.readouterr().err
            assert data_location.read_selection() == previous
            assert (await client.get("/api/health")).status_code == 200
            assert (await client.get("/api/settings/data-location")).json()["database_path"] == str(
                path
            )
            assert (await client.get("/_startup/state")).json()["warning"] == state["warning"]
            with pytest.raises(FileLockError):
                with exclusive_file_lock(Path(f"{path}.worker.lock")):
                    pass
            rejected = await client.post(
                "/_startup/select",
                json={"directory": str(tmp_path / "another"), "mode": "new"},
                headers={
                    "Origin": "http://127.0.0.1:8010",
                    "X-Folio-Startup-Token": service.token,
                },
            )
            assert rejected.status_code == 409
            assert not (tmp_path / "another").exists()
    finally:
        await service.close()
    with exclusive_file_lock(Path(f"{path}.worker.lock")):
        pass
    next_status = data_location.location_status()
    assert not next_status.recovery
    if previous is None:
        assert next_status.needs_selection
        assert next_status.settings is None
    else:
        assert next_status.settings is not None
        assert next_status.settings.database.path == previous


@pytest.mark.asyncio
async def test_automatic_startup_failure_never_remembers_or_silently_creates_other_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    selected = tmp_path / "existing/app.db"
    settings = Settings(database=DatabaseSettings(path=selected))

    def migrate(path: Path, require_existing: bool) -> None:
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
    service = StartupService(
        initial_status(tmp_path), lambda path, exists: None, lambda path: FastAPI()
    )
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

    def migrate(database: Path, require_existing: bool) -> None:
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
    assert state.error and "初始化学习应用失败" in state.error
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

    def fail_first(database: Path, require_existing: bool) -> None:
        nonlocal first
        if first:
            first = False
            with exclusive_file_lock(Path(f"{database}.worker.lock")):
                raise PermissionError("数据库写入被拒绝")
        migrate(database, require_existing)

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

    def fail_first(path: Path, require_existing: bool) -> None:
        nonlocal first
        if first:
            first = False
            path.parent.mkdir()
            with exclusive_file_lock(Path(f"{path}.worker.lock")):
                raise PermissionError("初次环境配置目录写入被拒绝")
        migrate(path, require_existing)

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

    def denied(path: Path, require_existing: bool) -> None:
        assert require_existing
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
        service = StartupService(status, lambda path, exists: None, lambda path: FastAPI())
        await service.initialize()
        assert service.state().retry_current_path is None
        with pytest.raises(ValueError, match="请先选择数据目录"):
            await service.retry_current()
        assert not (tmp_path / "missing").exists()
        await service.close()
