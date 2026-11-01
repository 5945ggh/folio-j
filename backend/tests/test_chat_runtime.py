"""Exercise the durable worker through offline adapters, never real providers."""

import asyncio
import json
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx2 as model_httpx
import pytest
from chat_tool_fixture import install_text_turn
from httpx import AsyncClient
from openai import APITimeoutError
from support_api import accept, chat_client, seed_chat

from app.jobs import agent, runtime
from app.llm import adapters
from app.services import settings as settings_service


@pytest.fixture(autouse=True)
def offline_runtime_discovery(monkeypatch: pytest.MonkeyPatch) -> None:
    async def discover(_url: str, _key: str | None) -> list[str]:
        return []

    monkeypatch.setattr(adapters, "discover_models", discover)


async def current_seed(client: AsyncClient, seed: dict[str, Any]) -> dict[str, Any]:
    return {
        **seed,
        "thread": (await client.get(f"/api/threads/{seed['thread']['id']}")).json(),
        "segment": (await client.get(f"/api/segments/{seed['segment']['id']}")).json(),
    }


async def terminal(client: AsyncClient, job_id: str) -> dict[str, Any]:
    async def poll() -> dict[str, Any]:
        while True:
            response = await client.get(f"/api/jobs/{job_id}")
            assert response.status_code == 200, response.text
            job = response.json()
            if job["status"] not in {"queued", "running", "stopping"}:
                return job
            await asyncio.sleep(0.01)

    return await asyncio.wait_for(poll(), timeout=4)


@pytest.mark.asyncio
async def test_worker_uses_accepted_snapshot_and_preserves_successful_history(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: list[tuple[adapters.CallSnapshot, str | None]] = []

    async def generate(
        snapshot: adapters.CallSnapshot,
        key: str | None,
        progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        captured.append((snapshot, key))
        await progress("これは過去形です。")
        return adapters.GenerateResult("これは過去形です。", True, None, "{}")

    install_text_turn(monkeypatch, generate)
    async with chat_client(tmp_path / "chat.db") as (client, app):
        seed = await seed_chat(client)
        original = await accept(client, seed)
        assert (
            await client.patch(
                f"/api/providers/{seed['provider']['id']}",
                json={"api_key": "replacement-fictional-key", "protocol": "responses"},
            )
        ).status_code == 200
        assert (
            await client.put(
                "/api/settings/profile",
                json={
                    "native_language": "English",
                    "explain_language": "English",
                    "level_note": "changed-after-accept",
                },
            )
        ).status_code == 200
        assert (
            await client.patch(
                f"/api/segments/{seed['segment']['id']}",
                json={
                    "context_before": "changed-context",
                    "expected_revision": seed["segment"]["revision"],
                },
            )
        ).status_code == 200
        await runtime.execute_job(app, original["id"])
        first = (await client.get(f"/api/jobs/{original['id']}")).json()
        assert first["status"] == "succeeded"
        assert first["assistant_message"]["status"] == "complete"
        snapshot, key = captured[0]
        assert key == "fictional-chat-secret"
        assert snapshot.protocol == "chat_completions"
        assert "changed-after-accept" not in json.dumps(snapshot.messages, ensure_ascii=False)
        assert "changed-context" not in json.dumps(snapshot.messages, ensure_ascii=False)
        assert "昨日は雨だった。" in json.dumps(snapshot.messages, ensure_ascii=False)
        assert (await client.get("/api/runs")).json() == []
        run = (await client.get(f"/api/runs/{first['run_id']}")).json()
        assert run["purpose"] == "chat"
        assert run["usage"] is None
        model = (await client.get(f"/api/providers/{seed['provider']['id']}")).json()["models"][0]
        assert model["text_status"] == model["stream_status"] == "unknown"
        assert model["text_verification"] is None
        assert model["stream_verification"] is None
        second = await accept(client, await current_seed(client, seed), question="现在形是什么？")
        await runtime.execute_job(app, second["id"])
        assert captured[1][0].protocol == "responses"
        messages = captured[1][0].messages
        assert messages is not None
        assert any(
            message["role"] == "user" and "過去形" in message["content"] for message in messages
        )
        assert not any(message["role"] == "assistant" for message in messages)
        other = await client.post(
            f"/api/segments/{seed['segment']['id']}/threads", json={"request_id": str(uuid4())}
        )
        isolated = await accept(
            client, {**(await current_seed(client, seed)), "thread": other.json()}
        )
        await runtime.execute_job(app, isolated["id"])
        assert not any(message["role"] == "assistant" for message in captured[2][0].messages or [])


@pytest.mark.asyncio
@pytest.mark.parametrize("text,complete", [("", True), ("残缺回答", False)])
async def test_incomplete_output_never_becomes_successful_history(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, text: str, complete: bool
) -> None:
    async def generate(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        await progress(text)
        return adapters.GenerateResult(text, complete, None, "{}")

    install_text_turn(monkeypatch, generate)
    async with chat_client(tmp_path / "chat.db") as (client, app):
        seed = await seed_chat(client)
        job = await accept(client, seed)
        await runtime.execute_job(app, job["id"])
        result = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert result["status"] == "failed"
        assert result["assistant_message"]["status"] == "failed"
        assert result["error_code"] == "incomplete_output"
        assert (await client.get(f"/api/runs/{result['run_id']}")).json()["status"] == "failed"
        assert (await client.get(f"/api/threads/{seed['thread']['id']}")).json()[
            "active_job_id"
        ] is None


@pytest.mark.asyncio
async def test_stop_fences_late_output_without_releasing_call_slot_early(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    started = asyncio.Event()
    release = asyncio.Event()

    async def generate(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        await progress("已保存的残文")
        started.set()
        while not release.is_set():
            try:
                await release.wait()
            except asyncio.CancelledError:
                pass
        await progress("旧任务迟到的正文")
        return adapters.GenerateResult("旧任务迟到的完整回答", True, None, "{}")

    install_text_turn(monkeypatch, generate)
    async with chat_client(tmp_path / "chat.db") as (client, app):
        seed = await seed_chat(client)
        job = await accept(client, seed)
        task = asyncio.create_task(runtime.execute_job(app, job["id"]))
        try:
            await asyncio.wait_for(started.wait(), timeout=2)
            before = (await client.get(f"/api/jobs/{job['id']}")).json()
            stopped = await client.post(f"/api/jobs/{job['id']}/stop")
            assert stopped.status_code == 200
            final = await terminal(client, job["id"])
            assert final["status"] == "interrupted"
            assert app.state.verification_semaphore._value == 1
            next_job = await accept(client, await current_seed(client, seed), question="新的问题")
            release.set()
            await asyncio.wait_for(task, timeout=2)
            late = (await client.get(f"/api/jobs/{job['id']}")).json()
            assert late == final
            assert late["assistant_message"]["content"] == before["assistant_message"]["content"]
            assert (await client.get(f"/api/threads/{seed['thread']['id']}")).json()[
                "active_job_id"
            ] == next_job["id"]
        finally:
            release.set()
            await asyncio.wait_for(task, timeout=2)


@pytest.mark.asyncio
async def test_chat_and_verification_share_two_generation_slots(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    entered = 0
    peak = 0
    calls = 0
    two_entered = asyncio.Event()
    release = asyncio.Event()

    async def generate(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        _progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        nonlocal entered, peak, calls
        entered += 1
        calls += 1
        peak = max(peak, entered)
        if entered == 2:
            two_entered.set()
        try:
            await release.wait()
            return adapters.GenerateResult("成功", True, None, "{}")
        finally:
            entered -= 1

    install_text_turn(monkeypatch, generate)
    monkeypatch.setattr(adapters, "generate_text", generate)
    async with chat_client(tmp_path / "chat.db") as (client, app):
        seed = await seed_chat(client)
        first = await accept(client, seed)
        other = await client.post(
            f"/api/segments/{seed['segment']['id']}/threads", json={"request_id": str(uuid4())}
        )
        second = await accept(client, {**seed, "thread": other.json()})
        verification = await client.post(
            f"/api/provider-models/{seed['model']['id']}/verifications", json={"stream": False}
        )
        tasks = [
            asyncio.create_task(runtime.execute_job(app, first["id"])),
            asyncio.create_task(runtime.execute_job(app, second["id"])),
            asyncio.create_task(
                settings_service.execute_verification(app, verification.json()["id"])
            ),
        ]
        try:
            await asyncio.wait_for(two_entered.wait(), timeout=2)
            await asyncio.sleep(0.03)
            assert calls == 2
        finally:
            release.set()
            await asyncio.wait_for(asyncio.gather(*tasks), timeout=3)
        assert peak == 2
        assert calls == 3
        assert len((await client.get("/api/runs")).json()) == 1


@pytest.mark.asyncio
async def test_second_process_owner_cannot_interrupt_existing_task(tmp_path: Path) -> None:
    database = tmp_path / "chat.db"
    async with chat_client(database) as (client, _app):
        seed = await seed_chat(client)
        job = await accept(client, seed)
        with pytest.raises(RuntimeError):
            async with chat_client(database):
                pytest.fail("second application acquired the live database")
        assert (await client.get(f"/api/jobs/{job['id']}")).json()["status"] == "queued"


@pytest.mark.asyncio
@pytest.mark.parametrize("via_progress", [False, True])
async def test_output_budget_never_persists_oversized_results(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, via_progress: bool
) -> None:
    monkeypatch.setattr(agent, "OUTPUT_CHAR_LIMIT", 16)

    async def generate(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        if via_progress:
            await progress("长" * 17)
        return adapters.GenerateResult("长" * 17, True, None, "长" * 17)

    install_text_turn(monkeypatch, generate)
    async with chat_client(tmp_path / "chat.db") as (client, app):
        seed = await seed_chat(client)
        job = await accept(client, seed)
        await runtime.execute_job(app, job["id"])
        result = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert result["status"] == "failed"
        assert result["error_code"] == "output_limit"
        assert len(result["assistant_message"]["content"]) <= 16
        run = (await client.get(f"/api/runs/{result['run_id']}")).json()
        assert len(run["output_text"]) <= 16


@pytest.mark.asyncio
async def test_stop_cannot_commit_between_dispatch_check_and_sdk_entry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    checked = asyncio.Event()
    allow_dispatch = asyncio.Event()
    finish_call = asyncio.Event()
    stop_committed = asyncio.Event()
    entries_after_stop: list[bool] = []
    original_check = vars(runtime)["_call_authorized"]
    first_check = True

    async def delayed_check(application: Any, job_id: str, token: str) -> bool:
        nonlocal first_check
        state: bool = await original_check(application, job_id, token)
        if first_check and state:
            first_check = False
            checked.set()
            await allow_dispatch.wait()
        return state

    async def generate(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        _progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        entries_after_stop.append(stop_committed.is_set())
        await finish_call.wait()
        return adapters.GenerateResult("成功", True, None, "{}")

    monkeypatch.setattr(runtime, "_call_authorized", delayed_check)
    install_text_turn(monkeypatch, generate)
    async with chat_client(tmp_path / "chat.db") as (client, app):
        seed = await seed_chat(client)
        job = await accept(client, seed)
        execution = asyncio.create_task(runtime.execute_job(app, job["id"]))
        await asyncio.wait_for(checked.wait(), timeout=2)

        async def stop() -> None:
            response = await client.post(f"/api/jobs/{job['id']}/stop")
            assert response.status_code == 200
            stop_committed.set()

        stopping = asyncio.create_task(stop())
        try:
            await asyncio.sleep(0.03)
            assert not stopping.done(), (
                "stop committed while an unchecked dispatch could still start"
            )
            allow_dispatch.set()
            await asyncio.wait_for(stopping, timeout=2)
            assert entries_after_stop == [False]
        finally:
            allow_dispatch.set()
            finish_call.set()
            await asyncio.wait_for(asyncio.gather(execution, stopping), timeout=3)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure", ["provider_error", "timeout", "sdk_timeout", "progress_limit", "result_limit"]
)
async def test_reply_failure_preserves_durable_partial_without_success_or_history(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    partial = "## 已脱敏的残文\n\n已经收到的有效讲解正文 [REDACTED]"
    captured: list[adapters.CallSnapshot] = []

    async def generate(
        snapshot: adapters.CallSnapshot,
        _key: str | None,
        progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        captured.append(snapshot)
        if len(captured) > 1:
            return adapters.GenerateResult("后续正常回答", True, None, "{}")
        await progress(partial)
        if failure == "provider_error":
            raise ConnectionError("synthetic connection failure")
        if failure == "timeout":
            raise TimeoutError()
        if failure == "sdk_timeout":
            raise APITimeoutError(model_httpx.Request("POST", "https://offline.invalid/"))
        if failure == "progress_limit":
            await progress("超" * (agent.OUTPUT_CHAR_LIMIT + 1))
        return adapters.GenerateResult("超" * (agent.OUTPUT_CHAR_LIMIT + 1), True, None, "{}")

    install_text_turn(monkeypatch, generate)
    async with chat_client(tmp_path / "quick-failure.db") as (client, app):
        seed = await seed_chat(client)
        job = await accept(client, seed)
        await runtime.execute_job(app, job["id"])
        failed = (await client.get(f"/api/jobs/{job['id']}")).json()
        expected_code = "output_limit" if failure.endswith("limit") else failure
        if failure == "sdk_timeout":
            expected_code = "timeout"
        assert failed["status"] == "failed"
        assert failed["error_code"] == expected_code
        assert failed["artifacts"] == []
        assert failed["assistant_message"]["status"] == "failed"
        assert failed["assistant_message"]["content"] == partial
        run = (await client.get(f"/api/runs/{failed['run_id']}")).json()
        assert run["status"] == "failed"
        if expected_code == "timeout":
            assert run["error"] == failed["error"] == "模型调用超时（本次等待上限 180 秒）"
        assert run["output_text"] == partial
        analyses = await client.get(f"/api/segments/{seed['segment']['id']}/analyses")
        assert analyses.json() == []
        next_job = await accept(client, await current_seed(client, seed), question="新的问题")
        await runtime.execute_job(app, next_job["id"])
        assert partial not in json.dumps(captured[-1].messages, ensure_ascii=False)
