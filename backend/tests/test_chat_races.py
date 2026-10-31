"""Forced interleavings for durable chat acceptance and worker fencing."""

import asyncio
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest
from chat_tool_fixture import install_text_turn
from support_api import accept, chat_client, question_payload, seed_chat

from app.jobs import runtime
from app.llm import adapters
from app.services import chat as chat_service
from app.services import sources as sources_service


@pytest.fixture(autouse=True)
def offline_discovery(monkeypatch: pytest.MonkeyPatch) -> None:
    async def discovered(_url: str, _key: str | None) -> list[str]:
        return []

    monkeypatch.setattr(adapters, "discover_models", discovered)


@pytest.mark.asyncio
@pytest.mark.parametrize("winner", ["edit", "accept"])
async def test_accept_and_text_edit_have_a_single_winner(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, winner: str
) -> None:
    async with chat_client(tmp_path / "chat.db") as (client, _app):
        seed = await seed_chat(client)
        segment_url = f"/api/segments/{seed['segment']['id']}"
        job_url = f"/api/threads/{seed['thread']['id']}/jobs"
        entered = asyncio.Event()
        release = asyncio.Event()
        if winner == "edit":
            original = chat_service.begin_write

            async def delayed_accept(session: Any) -> None:
                entered.set()
                await release.wait()
                await original(session)

            monkeypatch.setattr(chat_service, "begin_write", delayed_accept)
            pending = asyncio.create_task(client.post(job_url, json=question_payload(seed)))
            await asyncio.wait_for(entered.wait(), timeout=2)
            edit = await client.patch(segment_url, json={"text": "今日は晴れだ。"})
            assert edit.status_code == 200, edit.text
            release.set()
            accepted = await pending
            assert accepted.status_code == 409
            assert accepted.json()["code"] == "stale_segment"
            current = (await client.get(segment_url)).json()
            assert current["text"] == "今日は晴れだ。"
            assert current["text_locked_at"] is None
            assert (await client.get(f"/api/threads/{seed['thread']['id']}/messages")).json()[
                "items"
            ] == []
        else:
            original = sources_service.begin_write

            async def delayed_edit(session: Any) -> None:
                entered.set()
                await release.wait()
                await original(session)

            monkeypatch.setattr(sources_service, "begin_write", delayed_edit)
            pending = asyncio.create_task(
                client.patch(segment_url, json={"text": "今日は晴れだ。"})
            )
            await asyncio.wait_for(entered.wait(), timeout=2)
            accepted = await client.post(job_url, json=question_payload(seed))
            assert accepted.status_code == 202, accepted.text
            release.set()
            edit = await pending
            assert edit.status_code == 409
            current = (await client.get(segment_url)).json()
            assert current["text"] == seed["segment"]["text"]
            assert current["text_locked_at"] is not None


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["stop", "delete"])
async def test_stop_or_delete_after_claim_prevents_sdk_entry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, action: str
) -> None:
    calls = 0
    claimed = asyncio.Event()
    release = asyncio.Event()
    original_claim = vars(runtime)["_claim"]

    async def paused_claim(app: Any, job_id: str) -> Any:
        result = await original_claim(app, job_id)
        claimed.set()
        await release.wait()
        return result

    async def generate(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        _progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        nonlocal calls
        calls += 1
        return adapters.GenerateResult("should not happen", True, None, None)

    monkeypatch.setattr(runtime, "_claim", paused_claim)
    install_text_turn(monkeypatch, generate)
    async with chat_client(tmp_path / "chat.db") as (client, app):
        seed = await seed_chat(client)
        job = await accept(client, seed)
        task = asyncio.create_task(runtime.execute_job(app, job["id"]))
        try:
            await asyncio.wait_for(claimed.wait(), timeout=2)
            if action == "stop":
                changed = await client.post(f"/api/jobs/{job['id']}/stop")
                assert changed.status_code == 200, changed.text
                assert changed.json()["status"] == "stopping"
            else:
                changed = await client.delete(f"/api/segments/{seed['segment']['id']}")
                assert changed.status_code == 204, changed.text
            release.set()
            await asyncio.wait_for(task, timeout=2)
            assert calls == 0
            if action == "stop":
                final = (await client.get(f"/api/jobs/{job['id']}")).json()
                assert final["status"] == "interrupted"
            else:
                assert (await client.get(f"/api/jobs/{job['id']}")).status_code == 404
        finally:
            release.set()
            if not task.done():
                await asyncio.wait_for(task, timeout=2)


@pytest.mark.asyncio
async def test_missing_accepted_credential_fails_without_a_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = 0

    async def generate(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        _progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        nonlocal calls
        calls += 1
        return adapters.GenerateResult("unexpected", True, None, None)

    install_text_turn(monkeypatch, generate)
    database = tmp_path / "chat.db"
    async with chat_client(database) as (client, app):
        seed = await seed_chat(client)
        job = await accept(client, seed)
        for secret_file in (tmp_path / "chat.db.secrets").iterdir():
            secret_file.unlink()
        await runtime.execute_job(app, job["id"])
        result = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert result["status"] == "failed"
        assert result["error_code"] == "credential_unavailable"
        assert result["run_id"] is None
        assert result["assistant_message"]["status"] == "failed"
        assert calls == 0
        assert (await client.get(f"/api/threads/{seed['thread']['id']}")).json()[
            "active_job_id"
        ] is None
        assert (await client.get(f"/api/segments/{seed['segment']['id']}")).json()[
            "text_locked_at"
        ] is not None


@pytest.mark.asyncio
@pytest.mark.parametrize("stopping", [False, True])
async def test_recovery_interrupts_run_message_and_thread_without_late_overwrite(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stopping: bool
) -> None:
    started = asyncio.Event()
    release = asyncio.Event()

    async def generate(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        await progress("已提交残文")
        started.set()
        while not release.is_set():
            try:
                await release.wait()
            except asyncio.CancelledError:
                pass
        await progress("迟到正文")
        return adapters.GenerateResult("迟到完整回答", True, None, "{}")

    install_text_turn(monkeypatch, generate)
    async with chat_client(tmp_path / "chat.db") as (client, app):
        seed = await seed_chat(client)
        job = await accept(client, seed)
        task = asyncio.create_task(runtime.execute_job(app, job["id"]))
        try:
            await asyncio.wait_for(started.wait(), timeout=2)
            if stopping:
                stopped = await client.post(f"/api/jobs/{job['id']}/stop")
                assert stopped.status_code == 200, stopped.text
                assert stopped.json()["status"] == "stopping"
            async with app.state.session_factory() as session:
                await runtime.recover_chat_jobs(session)
            recovered = (await client.get(f"/api/jobs/{job['id']}")).json()
            assert recovered["status"] == "interrupted"
            assert recovered["error_code"] == "process_interrupted"
            assert recovered["assistant_message"]["status"] == "interrupted"
            assert recovered["assistant_message"]["content"] == "已提交残文"
            assert (await client.get(f"/api/runs/{recovered['run_id']}")).json()[
                "status"
            ] == "interrupted"
            assert (await client.get(f"/api/threads/{seed['thread']['id']}")).json()[
                "active_job_id"
            ] is None
            release.set()
            await asyncio.wait_for(task, timeout=2)
            assert (await client.get(f"/api/jobs/{job['id']}")).json() == recovered
        finally:
            release.set()
            if not task.done():
                await asyncio.wait_for(task, timeout=2)


@pytest.mark.asyncio
async def test_failed_round_remains_visible_but_is_not_sent_as_successful_history(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: list[adapters.CallSnapshot] = []

    async def generate(
        snapshot: adapters.CallSnapshot,
        _key: str | None,
        progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        captured.append(snapshot)
        if len(captured) == 1:
            await progress("残缺回答")
            return adapters.GenerateResult("残缺回答", False, None, None)
        return adapters.GenerateResult("完整回答", True, None, None)

    install_text_turn(monkeypatch, generate)
    async with chat_client(tmp_path / "chat.db") as (client, app):
        seed = await seed_chat(client)
        failed = await accept(client, seed)
        await runtime.execute_job(app, failed["id"])
        assert (await client.get(f"/api/jobs/{failed['id']}")).json()["status"] == "failed"
        current = {
            **seed,
            "thread": (await client.get(f"/api/threads/{seed['thread']['id']}")).json(),
            "segment": (await client.get(f"/api/segments/{seed['segment']['id']}")).json(),
        }
        second = await accept(client, current, question="新的问题")
        await runtime.execute_job(app, second["id"])
        messages = captured[1].messages or []
        rendered = [message["content"] for message in messages]
        assert not any("残缺回答" in value for value in rendered)
        assert not any("だった是什么意思？" in value for value in rendered)
        history = (await client.get(f"/api/threads/{seed['thread']['id']}/messages")).json()[
            "items"
        ]
        assert [(item["role"], item["status"]) for item in history] == [
            ("user", "complete"),
            ("assistant", "failed"),
            ("user", "complete"),
            ("assistant", "complete"),
        ]
