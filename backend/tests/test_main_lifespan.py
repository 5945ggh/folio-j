"""The database lock encloses startup recovery and every shutdown path."""

from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from support_api import api_client

from app import main
from app.jobs.supervision import BackgroundWorker
from app.main import create_app
from app.platform_io import exclusive_file_lock


@pytest.mark.asyncio
async def test_second_application_cannot_run_recovery_or_start_workers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "app.db"
    recovery = AsyncMock(wraps=main.recover_chat_jobs)
    monkeypatch.setattr(main, "recover_chat_jobs", recovery)
    async with api_client(database):
        second = create_app(database_path=database)
        with pytest.raises(RuntimeError, match="数据库已有后台执行进程"):
            async with second.router.lifespan_context(second):
                pytest.fail("second application started")
        assert recovery.await_count == 1
    with exclusive_file_lock(database.with_name(database.name + ".worker.lock")):
        pass


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["initialization", "recovery", "request"])
async def test_startup_and_request_failure_release_database_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    database = tmp_path / "app.db"

    def fail_initialization(_path: Path) -> None:
        raise RuntimeError("injected failure")

    with monkeypatch.context() as patch:
        if failure == "initialization":
            patch.setattr(main, "DictionaryStore", fail_initialization)
        elif failure == "recovery":
            patch.setattr(
                main, "recover_chat_jobs", AsyncMock(side_effect=RuntimeError("injected failure"))
            )
        with pytest.raises(RuntimeError, match="injected failure"):
            async with api_client(database):
                raise RuntimeError("injected failure")
    with exclusive_file_lock(database.with_name(database.name + ".worker.lock")):
        pass
    async with api_client(database) as client:
        assert (await client.get("/api/health")).status_code == 200


@pytest.mark.asyncio
async def test_failed_worker_shutdown_waits_for_other_workers_before_releasing_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "app.db"
    lock = database.with_name(database.name + ".worker.lock")
    original = BackgroundWorker.close
    closed: set[str] = set()

    async def close(worker: BackgroundWorker) -> None:
        await original(worker)
        closed.add(worker.name)
        if worker.name == "chat":
            raise RuntimeError("injected shutdown failure")

    monkeypatch.setattr(BackgroundWorker, "close", close)
    with pytest.raises(RuntimeError, match="injected shutdown failure"):
        async with api_client(database):
            pass
    assert closed == {"chat", "translation", "verification"}
    with exclusive_file_lock(lock):
        pass
