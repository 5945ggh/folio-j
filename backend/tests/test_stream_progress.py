"""Bound stream persistence cost and exercise flushes with a deterministic clock."""

import asyncio
import math
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest
from chat_tool_fixture import install_text_turn
from sqlalchemy import event, select
from support_api import accept, chat_client, seed_chat

from app.chat_models import ChatMessage, Job
from app.jobs import agent, runtime
from app.llm import adapters
from app.settings_models import Run


@pytest.fixture(autouse=True)
def offline_discovery(monkeypatch: pytest.MonkeyPatch) -> None:
    async def discover(_url: str, _key: str | None) -> list[str]:
        return []

    monkeypatch.setattr(adapters, "discover_models", discover)


@pytest.mark.asyncio
@pytest.mark.parametrize("interval", [None, 0.3], ids=["production_policy", "compliant_300ms"])
async def test_stream_coalesces_500_chunks_and_queries_only_authorization_fields(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, interval: float | None
) -> None:
    if interval is not None:
        monkeypatch.setattr(agent, "PROGRESS_INTERVAL_SECONDS", interval)
    clock = [0.0]
    monkeypatch.setattr(agent, "monotonic", lambda: clock[0], raising=False)
    statements: list[str] = []
    callback_statements: list[str] = []
    final_text = "## 讲解\n\n" + "正文" * 500
    flushed: list[tuple[float, str]] = []
    callback_flushes: list[tuple[float, str]] = []
    receiving_chunks = False
    original_progress = vars(agent)["_progress"]

    async def record_progress(
        app: Any, job_id: str, token: str, value: str, *, first_output: bool
    ) -> None:
        flushed.append((clock[0], value))
        if receiving_chunks:
            callback_flushes.append((clock[0], value))
        await original_progress(app, job_id, token, value, first_output=first_output)

    monkeypatch.setattr(agent, "_progress", record_progress)

    async def generate(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        nonlocal receiving_chunks
        began = len(statements)
        receiving_chunks = True
        for chunk in range(1, 501):
            clock[0] = chunk / 1000
            await progress("## 讲解\n\n" + "正文" * chunk)
        receiving_chunks = False
        callback_statements.extend(statements[began:])
        return adapters.GenerateResult(final_text, True, None, "{}")

    install_text_turn(monkeypatch, generate)
    async with chat_client(tmp_path / "cost.db") as (client, app):
        seed = await seed_chat(client)
        job = await accept(client, seed)
        engine = app.state.session_factory.kw["bind"].sync_engine

        def observe(
            _connection: Any,
            _cursor: Any,
            statement: str,
            _parameters: Any,
            _context: Any,
            _executemany: Any,
        ) -> None:
            statements.append(statement)

        event.listen(engine, "before_cursor_execute", observe)
        try:
            await runtime.execute_job(app, job["id"])
        finally:
            event.remove(engine, "before_cursor_execute", observe)
        write_count = sum(statement == "BEGIN IMMEDIATE" for statement in statements)
        assert write_count <= 8, f"500 chunks opened {write_count} write transactions"
        progress_writes = sum(value == "BEGIN IMMEDIATE" for value in callback_statements)
        # Initial progress may be immediate. Subsequent ordinary writes must be
        # at least 250ms apart; a final forced flush may happen sooner. Slower
        # policies such as 300ms satisfy the same persistence-cost contract.
        assert callback_flushes
        assert all(
            later[0] - earlier[0] >= 0.25 - 1e-9
            for earlier, later in zip(callback_flushes, callback_flushes[1:], strict=False)
        )
        ordinary_write_limit = math.floor(clock[0] / 0.25) + 1
        assert progress_writes <= ordinary_write_limit
        assert len(callback_flushes) <= ordinary_write_limit
        assert len(flushed) <= ordinary_write_limit + 1
        assert flushed[-1][1] == final_text
        progress_selects = [value for value in callback_statements if value.startswith("SELECT")]
        assert progress_selects
        assert all("input_snapshot" not in value for value in progress_selects)
        assert all("execution_state" not in value for value in progress_selects)
        assert all("runs.messages" not in value for value in progress_selects)
        final = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert final["status"] == "succeeded"
        assert final["assistant_message"]["content"] == final_text
        run = (await client.get(f"/api/runs/{final['run_id']}")).json()
        assert run["output_text"] == final_text


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["provider_error", "timeout", "output_limit"])
async def test_failure_flushes_latest_buffer_and_fences_retained_callback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    monkeypatch.setattr(agent, "monotonic", lambda: 0.0, raising=False)
    buffer_ready = asyncio.Event()
    if failure == "timeout":
        monkeypatch.setattr(agent, "CALL_SECONDS", 1)
        original_authorized = vars(agent)["_authorized"]
        authorization_checks = 0

        async def authorize_after_buffer(app: Any, job_id: str, token: str) -> bool:
            nonlocal authorization_checks
            authorization_checks += 1
            if authorization_checks > 1:
                # The initial dispatch check must remain free to start the adapter.
                # Gate deadline observation until both intended callbacks are received.
                await asyncio.wait_for(buffer_ready.wait(), timeout=5)
            return await original_authorized(app, job_id, token)

        monkeypatch.setattr(agent, "_authorized", authorize_after_buffer)
    retained: list[Callable[[str], Awaitable[None]]] = []
    raw_latest = "第一段，未到250ms的最新残文 fictional-chat-secret"
    latest = raw_latest.replace("fictional-chat-secret", "[已隐藏凭据]")

    async def generate(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        retained.append(progress)
        await progress("第一段")
        await progress(raw_latest)
        buffer_ready.set()
        if failure == "provider_error":
            raise ConnectionError("synthetic failure")
        if failure == "output_limit":
            await progress("超" * (agent.OUTPUT_CHAR_LIMIT + 1))
        await asyncio.Event().wait()
        raise AssertionError("timeout should cancel the adapter")

    install_text_turn(monkeypatch, generate)
    async with chat_client(tmp_path / "flush.db") as (client, app):
        seed = await seed_chat(client)
        job = await accept(client, seed)
        await runtime.execute_job(app, job["id"])
        final = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert final["status"] == "failed"
        assert final["error_code"] == failure
        assert buffer_ready.is_set()
        assert final["assistant_message"]["content"] == latest
        run = (await client.get(f"/api/runs/{final['run_id']}")).json()
        assert run["output_text"] == latest
        await retained[0]("迟到输出")
        assert (await client.get(f"/api/jobs/{job['id']}")).json() == final
        assert (await client.get(f"/api/runs/{final['run_id']}")).json() == run


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["stop", "delete"])
async def test_buffered_and_late_callbacks_cannot_write_after_stop_or_delete(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, action: str
) -> None:
    monkeypatch.setattr(agent, "monotonic", lambda: 0.0)
    entered = asyncio.Event()
    release = asyncio.Event()

    async def generate(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        await progress("已保存残文")
        await progress("停止前不足250ms的缓冲内容")
        entered.set()
        while not release.is_set():
            try:
                await release.wait()
            except asyncio.CancelledError:
                pass
        await progress("撤销授权后的迟到内容")
        return adapters.GenerateResult("迟到完整结果", True, None, "{}")

    install_text_turn(monkeypatch, generate)
    async with chat_client(tmp_path / "race.db") as (client, app):
        seed = await seed_chat(client)
        job = await accept(client, seed)
        task = asyncio.create_task(runtime.execute_job(app, job["id"]))
        try:
            await asyncio.wait_for(entered.wait(), timeout=2)
            if action == "stop":
                response = await client.post(f"/api/jobs/{job['id']}/stop")
                assert response.status_code == 200
            else:
                response = await client.delete(f"/api/segments/{seed['segment']['id']}")
                assert response.status_code == 204
            release.set()
            await asyncio.wait_for(task, timeout=2)
            async with app.state.session_factory() as session:
                stored = await session.get(Job, job["id"])
                assert stored is not None
                assert stored.status == "interrupted"
                assert stored.execution_token is None
                message = await session.scalar(
                    select(ChatMessage).where(
                        ChatMessage.job_id == job["id"], ChatMessage.role == "assistant"
                    )
                )
                run = await session.scalar(select(Run).where(Run.job_id == job["id"]))
                assert message is not None and run is not None
                assert message.content == run.output_text == "已保存残文"
        finally:
            release.set()
            await asyncio.wait_for(task, timeout=2)


@pytest.mark.asyncio
async def test_supervisor_flushes_pending_text_while_upstream_is_idle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = [0.0]
    monkeypatch.setattr(agent, "monotonic", lambda: clock[0])
    ready = asyncio.Event()
    flushed = asyncio.Event()
    release = asyncio.Event()
    latest = "首段之后到达、随后上游暂停的第二段"
    original_progress = vars(agent)["_progress"]

    async def record_progress(
        app: Any, job_id: str, token: str, value: str, *, first_output: bool
    ) -> None:
        await original_progress(app, job_id, token, value, first_output=first_output)
        if value == latest:
            flushed.set()

    monkeypatch.setattr(agent, "_progress", record_progress)

    async def generate(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        await progress("首段")
        clock[0] = 0.01
        await progress(latest)
        ready.set()
        await release.wait()
        return adapters.GenerateResult(latest, True, None, "{}")

    install_text_turn(monkeypatch, generate)
    async with chat_client(tmp_path / "idle.db") as (client, app):
        seed = await seed_chat(client)
        job = await accept(client, seed)
        task = asyncio.create_task(runtime.execute_job(app, job["id"]))
        try:
            await asyncio.wait_for(ready.wait(), timeout=2)
            before = (await client.get(f"/api/jobs/{job['id']}")).json()
            assert before["assistant_message"]["content"] == "首段"
            assert before["active_step"] == "streaming"
            clock[0] = 1.0
            await asyncio.wait_for(flushed.wait(), timeout=2)
            current = (await client.get(f"/api/jobs/{job['id']}")).json()
            assert current["status"] == "running"
            assert current["assistant_message"]["content"] == latest
        finally:
            release.set()
            await asyncio.wait_for(task, timeout=2)
