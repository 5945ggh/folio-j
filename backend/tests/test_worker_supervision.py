"""Offline worker fault injection through public supervision and real API dispatch."""

import asyncio
import logging
import sqlite3
from collections.abc import Awaitable, Callable
from functools import partial
from pathlib import Path
from typing import Any

import pytest
from chat_tool_fixture import install_text_turn
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from test_analysis_agent import DOCUMENT, call, refreshed, scripted_turn
from test_chat_api import accept, chat_client, seed_chat
from test_segment_provenance import compiled_provenance
from test_source_segment import api_client
from test_translations import request as translation_request
from test_translations import setup as setup_translation
from test_worker_dispatch import wait_status

from app.jobs import agent, runtime, supervision
from app.jobs.supervision import BackgroundWorker, WorkerName, workers
from app.llm import adapters
from app.main import create_app
from app.services import settings, translations
from app.settings_models import Run

SECRET = "fictional-chat-secret，不能泄漏的学习原文"


@pytest.fixture(autouse=True)
def offline_discovery(monkeypatch: pytest.MonkeyPatch) -> None:
    async def discover(_url: str, _key: str | None) -> list[str]:
        return ["offline-model"]

    monkeypatch.setattr(adapters, "discover_models", discover)


async def until(predicate: Callable[[], bool]) -> None:
    async with asyncio.timeout(5):
        while True:
            if predicate():
                return
            await asyncio.sleep(0.01)


def assert_safe_logs(caplog: pytest.LogCaptureFixture) -> None:
    assert SECRET not in caplog.text
    records = [record for record in caplog.records if record.name == "app.jobs.supervision"]
    assert records
    assert all(record.exc_info is None for record in records)


@pytest.mark.asyncio
async def test_recovery_retries_without_repeating_execute_and_health_recovers(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.ERROR, logger="app.jobs.supervision")
    app = create_app()
    for background in workers(app).values():
        background.activate(enabled=True)
    background = workers(app)["chat"]
    execute_calls = recovery_calls = 0
    failed_recovery, permit_recovery = asyncio.Event(), asyncio.Event()

    async def scan() -> None:
        pass

    async def execute() -> None:
        nonlocal execute_calls
        execute_calls += 1
        raise RuntimeError(SECRET)

    async def recover() -> None:
        nonlocal recovery_calls
        recovery_calls += 1
        if not permit_recovery.is_set():
            failed_recovery.set()
            raise OSError(SECRET)

    background.start(scan, interval=60)
    task = background.submit("durable-job", execute, recover)
    try:
        await asyncio.wait_for(failed_recovery.wait(), 5)
        assert background.submit("durable-job", execute, recover) is task
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            degraded = (await client.get("/api/health")).json()
            state = degraded["workers"]["chat"]
            assert degraded["status"] == "degraded"
            assert state["status"] == "retrying" and state["active_tasks"] == 1
            assert state["failure_count"] >= 2
            assert state["last_error"] == "OSError" and state["last_failure_at"]
            assert SECRET not in str(degraded)
            permit_recovery.set()
            await asyncio.wait_for(task, 5)
            await until(lambda: not background.tasks)
            healthy = (await client.get("/api/health")).json()
            assert healthy["status"] == "ok"
            assert healthy["workers"]["chat"]["status"] == "healthy"
            assert healthy["workers"]["chat"]["active_tasks"] == 0
            assert healthy["workers"]["chat"]["failure_count"] == state["failure_count"]
            assert execute_calls == 1 and recovery_calls >= 2
    finally:
        await background.close()
    assert_safe_logs(caplog)


@pytest.mark.asyncio
async def test_close_cancels_scanner_execution_and_recovery_without_leftover_tasks() -> None:
    background = BackgroundWorker("translation")
    scanning, executing, recovering = asyncio.Event(), asyncio.Event(), asyncio.Event()
    stopped: set[str] = set()

    async def block(name: str, entered: asyncio.Event) -> None:
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.add(name)

    async def scan() -> None:
        await block("scan", scanning)

    async def execute() -> None:
        await block("execute", executing)

    async def fail() -> None:
        raise RuntimeError("local failure")

    async def recover() -> None:
        await block("recover", recovering)

    supervisor = background.start(scan, interval=60)
    active = background.submit("active", execute, recover)
    repair = background.submit("repair", fail, recover)
    try:
        await asyncio.wait_for(
            asyncio.gather(scanning.wait(), executing.wait(), recovering.wait()), 5
        )
    finally:
        await background.close()
    assert stopped == {"scan", "execute", "recover"}
    assert supervisor.done() and active.done() and repair.done()
    assert background.tasks == {} and background.status == "stopped"
    await background.close()


@pytest.mark.asyncio
async def test_repeated_scan_errors_back_off_cap_delay_and_reset_after_recovery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(supervision, "RETRY_SECONDS", 0.01)
    monkeypatch.setattr(supervision, "MAX_RETRY_SECONDS", 0.04)
    background = BackgroundWorker("chat")
    original_sleep = asyncio.sleep
    timers: asyncio.Queue[tuple[float, asyncio.Event]] = asyncio.Queue()
    calls = 0
    fail_again = False

    async def controlled_sleep(delay: float) -> None:
        if asyncio.current_task() is background.supervisor:
            release = asyncio.Event()
            timers.put_nowait((delay, release))
            await release.wait()
        else:
            await original_sleep(delay)

    async def scan() -> None:
        nonlocal calls, fail_again
        calls += 1
        if calls <= 4 or fail_again:
            fail_again = False
            raise OSError("local scan unavailable")

    monkeypatch.setattr(supervision.asyncio, "sleep", controlled_sleep)
    background.start(scan, interval=60)
    try:
        for attempt, expected_delay in enumerate((0.01, 0.02, 0.04, 0.04), start=1):
            delay, release = await asyncio.wait_for(timers.get(), 5)
            assert delay == pytest.approx(expected_delay)
            assert calls == attempt and background.failures == attempt
            assert background.status == "retrying"
            background.wake()
            await original_sleep(0)
            assert calls == attempt, "a wake must not spin scans during retry backoff"
            release.set()
        await until(lambda: background.status == "healthy")
        assert calls == 5 and background.failures == 4
        fail_again = True
        background.wake()
        delay, release = await asyncio.wait_for(timers.get(), 5)
        assert delay == pytest.approx(0.01), "successful scanning must reset retry delay"
        assert calls == 6 and background.status == "retrying"
        release.set()
        await until(lambda: background.status == "healthy")
        assert calls == 7 and background.failures == 5
    finally:
        await background.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("recovery_mode", ["blocked", "backoff"])
async def test_stopping_translation_during_recovery_clears_health_without_replaying(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    recovery_mode: str,
) -> None:
    caplog.set_level(logging.ERROR, logger="app.jobs.supervision")
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    monkeypatch.setattr(supervision, "RETRY_SECONDS", 60)
    original_begin = translations.begin_write
    recovery_entered = asyncio.Event()
    calls = repairs = 0

    async def fail_publish(_session: Any) -> None:
        monkeypatch.setattr(translations, "begin_write", original_begin)
        raise OSError(SECRET)

    async def recover(_app: FastAPI, _task_id: str) -> None:
        nonlocal repairs
        repairs += 1
        recovery_entered.set()
        if recovery_mode == "blocked":
            await asyncio.Event().wait()
        else:
            raise OSError(SECRET)

    async def generate(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        _progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        nonlocal calls
        calls += 1
        if calls == 1:
            monkeypatch.setattr(translations, "begin_write", fail_publish)
        return adapters.GenerateResult("不重复调用", True, None, "{}")

    monkeypatch.setattr(translations, "fail_task", recover)
    monkeypatch.setattr(translations, "generate_text", generate)
    async with api_client(tmp_path / f"cancel-repair-{recovery_mode}.db") as client:
        source, material, _seed = await setup_translation(client)
        path = f"/api/materials/{material['id']}/translations"
        response = await client.post(path, json=translation_request(source, material))
        assert response.status_code == 200, response.text
        task_path = f"/api/translation-tasks/{response.json()['id']}"
        await asyncio.wait_for(recovery_entered.wait(), 5)
        degraded = (await client.get("/api/health")).json()
        history = degraded["workers"]["translation"]
        assert degraded["status"] == "degraded"
        assert history["status"] == "retrying" and history["active_tasks"] == 1
        assert history["failure_count"] == (1 if recovery_mode == "blocked" else 2)
        assert history["last_error"] == "OSError" and history["last_failure_at"]
        stopped = await client.post(task_path + "/stop")
        assert stopped.status_code == 200, stopped.text
        assert stopped.json()["status"] == "cancelled"
        async with asyncio.timeout(5):
            while True:
                health = (await client.get("/api/health")).json()
                current = health["workers"]["translation"]
                if current["active_tasks"] == 0:
                    break
                await asyncio.sleep(0.01)
        assert current["status"] == "healthy" and health["status"] == "ok"
        for key in ("failure_count", "last_error", "last_failure_at"):
            assert current[key] == history[key]
        assert calls == repairs == 1
        cancelled = (await client.get(task_path)).json()
        assert cancelled["status"] == "cancelled" and cancelled["result_id"] is None
        run = (await client.get(f"/api/runs/{cancelled['run_id']}")).json()
        assert run["status"] == "cancelled" and run["finished_at"]
        response = await client.post(path, json=translation_request(source, material))
        assert response.status_code == 200, response.text
        done = await wait_status(
            client, f"/api/translation-tasks/{response.json()['id']}", "succeeded"
        )
        assert done["result_id"] and calls == 2 and repairs == 1
    assert_safe_logs(caplog)


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["chat", "translation"])
async def test_scanner_failure_recovers_and_dispatches_real_api_requests(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    name: WorkerName,
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    caplog.set_level(logging.ERROR, logger="app.jobs.supervision")
    target = runtime if name == "chat" else translations
    original_scan = vars(target)["_scan"]
    failed, permit_scan = asyncio.Event(), asyncio.Event()
    calls = 0

    async def scan(app: FastAPI) -> None:
        if not failed.is_set():
            failed.set()
            raise RuntimeError(SECRET)
        await permit_scan.wait()
        await original_scan(app)

    async def generate(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        _progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        nonlocal calls
        calls += 1
        return adapters.GenerateResult("离线回答", True, None, "{}")

    monkeypatch.setattr(target, "_scan", scan)
    install_text_turn(monkeypatch, generate)
    monkeypatch.setattr(translations, "generate_text", generate)
    async with api_client(tmp_path / f"scan-{name}.db") as client:
        await asyncio.wait_for(failed.wait(), 5)
        degraded = (await client.get("/api/health")).json()
        if name == "chat":
            seed = await seed_chat(client)
            accepted = await accept(client, seed)
            path = f"/api/jobs/{accepted['id']}"
        else:
            source, material, _seed = await setup_translation(client)
            response = await client.post(
                f"/api/materials/{material['id']}/translations",
                json=translation_request(source, material),
            )
            assert response.status_code == 200, response.text
            path = f"/api/translation-tasks/{response.json()['id']}"
        try:
            assert (await client.get(path)).json()["status"] == "queued"
        finally:
            permit_scan.set()
        done = await wait_status(client, path, "succeeded")
        assert degraded["status"] == "degraded"
        assert degraded["workers"][name]["status"] == "retrying"
        assert degraded["workers"][name]["last_error"] == "RuntimeError"
        assert calls == 1
        if name == "chat":
            assert done["assistant_message"]["content"] == "离线回答"
        else:
            result = (await client.get(f"/api/translation-results/{done['result_id']}")).json()
            assert result["translation"] == "离线回答"
        async with asyncio.timeout(5):
            while True:
                health = (await client.get("/api/health")).json()
                if health["status"] == "ok":
                    break
                await asyncio.sleep(0.01)
        assert health["workers"][name]["failure_count"] >= 1
        assert health["workers"][name]["last_failure_at"]
        assert SECRET not in str(health)
    assert_safe_logs(caplog)


@pytest.mark.asyncio
async def test_chat_unexpected_exit_preserves_saved_artifact_and_releases_thread(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.ERROR, logger="app.jobs.supervision")
    captured = scripted_turn(
        monkeypatch,
        [("", [call("save_analysis", {"source_md": DOCUMENT})], True), ("下一轮正常", [], True)],
    )
    original_next = vars(agent)["_next_run"]

    async def crash_after_next_run(
        app: FastAPI, job_id: str, token: str, messages: list[dict[str, Any]]
    ) -> bool:
        await original_next(app, job_id, token, messages)
        raise RuntimeError(SECRET)

    monkeypatch.setattr(agent, "_next_run", crash_after_next_run)
    database = tmp_path / "chat-exit.db"
    async with api_client(database) as client:
        seed = await seed_chat(client)
        accepted = await accept(client, seed)
        failed = await wait_status(client, f"/api/jobs/{accepted['id']}", "failed")
        assert failed["error_code"] == "worker_failed"
        assert failed["assistant_message"]["status"] == "failed"
        assert len(captured) == 1 and len(failed["artifacts"]) == 1
        artifact = failed["artifacts"][0]
        detail = (await client.get(f"/api/analyses/{artifact['analysis_id']}")).json()
        assert detail["source_md"] == DOCUMENT and detail["revision_id"] == artifact["revision_id"]
        thread = (await client.get(f"/api/threads/{seed['thread']['id']}")).json()
        assert thread["active_job_id"] is None
        with sqlite3.connect(database) as connection:
            assert connection.execute(
                "SELECT execution_token FROM chat_jobs WHERE id=?", (accepted["id"],)
            ).fetchone() == (None,)
            runs = connection.execute(
                "SELECT status,finished_at FROM runs WHERE job_id=? ORDER BY created_at,id",
                (accepted["id"],),
            ).fetchall()
        assert [run[0] for run in runs] == ["succeeded", "failed"]
        assert all(run[1] is not None for run in runs)
        later = await accept(client, await refreshed(client, seed))
        succeeded = await wait_status(client, f"/api/jobs/{later['id']}", "succeeded")
        assert succeeded["assistant_message"]["content"] == "下一轮正常"
        assert len(captured) == 2
        assert (await client.get(f"/api/analyses/{artifact['analysis_id']}")).json() == detail
        assert SECRET not in str(failed)
    assert_safe_logs(caplog)


@pytest.mark.asyncio
async def test_translation_publish_failure_closes_run_and_preserves_prior_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.ERROR, logger="app.jobs.supervision")
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    original_begin = translations.begin_write
    calls = 0

    async def fail_publish(session: Any) -> None:
        monkeypatch.setattr(translations, "begin_write", original_begin)
        raise RuntimeError(SECRET)

    async def generate(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        _progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        nonlocal calls
        calls += 1
        if calls == 2:
            monkeypatch.setattr(translations, "begin_write", fail_publish)
        return adapters.GenerateResult("已保存译文", True, None, "{}")

    monkeypatch.setattr(translations, "generate_text", generate)
    async with api_client(tmp_path / "translation-exit.db") as client:
        source, material, _seed = await setup_translation(client)

        async def submit() -> str:
            response = await client.post(
                f"/api/materials/{material['id']}/translations",
                json=translation_request(source, material),
            )
            assert response.status_code == 200, response.text
            return f"/api/translation-tasks/{response.json()['id']}"

        first = await wait_status(client, await submit(), "succeeded")
        result_path = f"/api/translation-results/{first['result_id']}"
        saved = (await client.get(result_path)).json()
        failed = await wait_status(client, await submit(), "failed")
        assert failed["result_id"] is None and failed["run_id"]
        run = (await client.get(f"/api/runs/{failed['run_id']}")).json()
        assert run["status"] == "failed" and run["finished_at"]
        last = await wait_status(client, await submit(), "succeeded")
        assert last["result_id"] and calls == 3
        assert (await client.get(result_path)).json() == saved
        assert (await client.get(f"/api/runs/{first['run_id']}")).json()["status"] == "succeeded"
        assert SECRET not in str(failed) + str(run)
    assert_safe_logs(caplog)


@pytest.mark.asyncio
async def test_translation_backlog_continues_without_waiting_for_idle_scan_interval(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    calls = 0

    async def generate(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        _progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        nonlocal calls
        calls += 1
        return adapters.GenerateResult(f"译文{calls}", True, None, "{}")

    monkeypatch.setattr(translations, "generate_text", generate)
    async with chat_client(tmp_path / "translation-backlog.db") as (client, app):
        source, material, _seed = await setup_translation(client)
        paths: list[str] = []
        for _ in range(2):
            response = await client.post(
                f"/api/materials/{material['id']}/translations",
                json=translation_request(source, material),
            )
            assert response.status_code == 200, response.text
            assert response.json()["status"] == "queued"
            paths.append(f"/api/translation-tasks/{response.json()['id']}")
        assert calls == 0
        background = workers(app)["translation"]
        background.start(partial(vars(translations)["_scan"], app), interval=60)
        try:
            done = await asyncio.gather(*(wait_status(client, path, "succeeded") for path in paths))
            assert calls == 2
            results = [
                (await client.get(f"/api/translation-results/{task['result_id']}")).json()
                for task in done
            ]
            assert {result["translation"] for result in results} == {"译文1", "译文2"}
            assert len({task["run_id"] for task in done}) == 2
        finally:
            await background.close()
        assert calls == 2


@pytest.mark.asyncio
async def test_verification_unexpected_exit_is_terminal_and_next_request_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.ERROR, logger="app.jobs.supervision")
    original_execute = settings.execute_verification
    executions = calls = 0

    async def execute(app: FastAPI, run_id: str) -> None:
        nonlocal executions
        executions += 1
        if executions == 1:
            async with app.state.session_factory() as session:
                row = await session.get(Run, run_id)
                assert row is not None
                row.status, row.started_at = "running", settings.now()
                await session.commit()
            raise RuntimeError(SECRET)
        await original_execute(app, run_id)

    async def generate(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        _progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        nonlocal calls
        calls += 1
        return adapters.GenerateResult("验证完成", True, None, "{}")

    monkeypatch.setattr(settings, "execute_verification", execute)
    monkeypatch.setattr(adapters, "generate_text", generate)
    async with api_client(tmp_path / "verification-exit.db") as client:
        seed = await seed_chat(client)
        path = f"/api/provider-models/{seed['model']['id']}/verifications"
        response = await client.post(path, json={"stream": False})
        assert response.status_code == 202, response.text
        failed = await wait_status(client, f"/api/runs/{response.json()['id']}", "failed")
        assert failed["finished_at"] and SECRET not in str(failed)
        model = (await client.get(f"/api/providers/{seed['provider']['id']}")).json()["models"][0]
        assert model["text_status"] == "failed"
        health = (await client.get("/api/health")).json()["workers"]["verification"]
        assert health["failure_count"] == 1 and health["last_error"] == "RuntimeError"
        response = await client.post(path, json={"stream": False})
        assert response.status_code == 202, response.text
        done = await wait_status(client, f"/api/runs/{response.json()['id']}", "succeeded")
        assert done["output_text"] == "验证完成" and executions == 2 and calls == 1
        model = (await client.get(f"/api/providers/{seed['provider']['id']}")).json()["models"][0]
        assert model["text_status"] == "succeeded"
    assert_safe_logs(caplog)
