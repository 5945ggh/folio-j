"""Offline API → worker → database acceptance for Analysis tool workflows."""

import json
import sqlite3
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from support_api import accept, chat_client, seed_chat

from app.jobs import runtime
from app.llm import adapters
from app.services.analyses import create_analysis
from app.services.sources import begin_write

Fake = Callable[..., Awaitable[adapters.ToolTurn]]


@pytest.fixture(autouse=True)
def offline_discovery(monkeypatch: pytest.MonkeyPatch) -> None:
    async def discover(_url: str, _key: str | None) -> list[str]:
        return ["offline-model"]

    monkeypatch.setattr(adapters, "discover_models", discover)


def _call(name: str, args: dict[str, Any], call_id: str = "call_1") -> dict[str, str]:
    return {"id": call_id, "name": name, "arguments": json.dumps(args, ensure_ascii=False)}


def _turn(
    snapshot: adapters.CallSnapshot,
    text: str,
    calls: list[dict[str, str]] | None = None,
    *,
    completed: bool = True,
) -> adapters.ToolTurn:
    calls = calls or []
    history: list[dict[str, Any]]
    if snapshot.protocol == "chat_completions":
        item: dict[str, Any] = {"role": "assistant", "content": text or None}
        if calls:
            item["tool_calls"] = [
                {
                    "id": call["id"],
                    "type": "function",
                    "function": {"name": call["name"], "arguments": call["arguments"]},
                }
                for call in calls
            ]
        history = [item]
    else:
        history = [
            {
                "type": "function_call",
                "call_id": call["id"],
                "name": call["name"],
                "arguments": call["arguments"],
            }
            for call in calls
        ]
        if text:
            history.append(
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": text}],
                }
            )
    return adapters.ToolTurn(
        text=text,
        completed=completed,
        calls=calls if completed else [],
        history_items=history if completed else [],
        usage={"input_tokens": 2, "output_tokens": 3, "total_tokens": 5},
        raw_response="{}",
    )


def _install(monkeypatch: pytest.MonkeyPatch, fake: Fake) -> None:
    monkeypatch.setattr(adapters, "complete_with_tools", fake)


async def _document(app: FastAPI, segment_id: str, body: str = "## 旧标题\n旧正文\n") -> Any:
    async with app.state.session_factory() as session:
        await begin_write(session)
        detail = await create_analysis(
            session,
            segment_id=segment_id,
            source_md=body,
            operation_key=f"fixture:{uuid4()}",
            origin="test",
        )
        await session.commit()
        return detail


async def _job(client: AsyncClient, job_id: str) -> dict[str, Any]:
    response = await client.get(f"/api/jobs/{job_id}")
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.asyncio
async def test_review_approval_is_idempotent_and_saves_one_revision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = 0
    document: Any = None

    async def fake(
        snapshot: adapters.CallSnapshot,
        _key: str | None,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        tool_choice: str = "auto",
        on_progress: Any = None,
        on_tool_name: Any = None,
    ) -> adapters.ToolTurn:
        nonlocal calls
        calls += 1
        if calls == 1:
            return _turn(
                snapshot,
                "修改建议",
                [
                    _call(
                        "update_analysis_section",
                        {
                            "analysis_id": document.id,
                            "base_revision_id": document.revision_id,
                            "sid": document.sections[1].uid,
                            "title": "新标题",
                        },
                    )
                ],
            )
        return _turn(snapshot, "已完成修改")

    _install(monkeypatch, fake)
    database = tmp_path / "approve.db"
    async with chat_client(database) as (client, app):
        seed = await seed_chat(client)
        document = await _document(app, seed["segment"]["id"])
        job = await accept(client, seed, question="把讲解标题改好")
        await runtime.execute_job(app, job["id"])
        waiting = await _job(client, job["id"])
        assert waiting["status"] == "waiting_review" and waiting["review_proposal"]
        body = {"expected_version": waiting["version"], "decision": "approve"}
        first = await client.post(f"/api/jobs/{job['id']}/decision", json=body)
        again = await client.post(f"/api/jobs/{job['id']}/decision", json=body)
        assert first.status_code == again.status_code == 200
        assert first.json()["version"] == again.json()["version"]
        await runtime.execute_job(app, job["id"])
        result = await _job(client, job["id"])
        assert result["status"] == "succeeded" and len(result["artifacts"]) == 1
        assert calls == 2
        current = (await client.get(f"/api/analyses/{document.id}")).json()
        assert current["sections"][1]["title"] == "新标题"
        assert current["revision_id"] != document.revision_id
        with sqlite3.connect(database) as connection:
            count = connection.execute(
                "SELECT count(*) FROM analysis_revisions WHERE analysis_id=?", (document.id,)
            ).fetchone()[0]
        assert count == 2


@pytest.mark.asyncio
async def test_review_rejection_with_instructions_keeps_original(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    document: Any = None
    continuation: list[dict[str, Any]] = []
    calls = 0

    async def fake(
        snapshot: adapters.CallSnapshot,
        _key: str | None,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        tool_choice: str = "auto",
        on_progress: Any = None,
        on_tool_name: Any = None,
    ) -> adapters.ToolTurn:
        nonlocal calls
        calls += 1
        if calls == 1:
            return _turn(
                snapshot,
                "待审",
                [
                    _call(
                        "delete_analysis_section",
                        {
                            "analysis_id": document.id,
                            "base_revision_id": document.revision_id,
                            "sid": document.sections[1].uid,
                        },
                    )
                ],
            )
        continuation.extend(messages)
        return _turn(snapshot, "收到，不删除")

    _install(monkeypatch, fake)
    async with chat_client(tmp_path / "reject.db") as (client, app):
        seed = await seed_chat(client)
        document = await _document(app, seed["segment"]["id"])
        job = await accept(client, seed)
        await runtime.execute_job(app, job["id"])
        waiting = await _job(client, job["id"])
        assert waiting["status"] == "waiting_review"
        response = await client.post(
            f"/api/jobs/{job['id']}/decision",
            json={
                "expected_version": waiting["version"],
                "decision": "reject",
                "additional_instructions": "保留这个讲解块",
            },
        )
        assert response.status_code == 200
        await runtime.execute_job(app, job["id"])
        assert (await _job(client, job["id"]))["artifacts"] == []
        assert (await client.get(f"/api/analyses/{document.id}")).json()[
            "revision_id"
        ] == document.revision_id
        assert "保留这个讲解块" in json.dumps(continuation, ensure_ascii=False)


@pytest.mark.asyncio
async def test_tool_cannot_read_other_segment_analysis(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target_id = ""
    tool_output = ""
    calls = 0

    async def fake(
        snapshot: adapters.CallSnapshot,
        _key: str | None,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        tool_choice: str = "auto",
        on_progress: Any = None,
        on_tool_name: Any = None,
    ) -> adapters.ToolTurn:
        nonlocal calls, tool_output
        calls += 1
        if calls == 1:
            return _turn(snapshot, "", [_call("read_analysis", {"analysis_id": target_id})])
        tool_output = json.dumps(messages[-1], ensure_ascii=False)
        return _turn(snapshot, "无权读取")

    _install(monkeypatch, fake)
    async with chat_client(tmp_path / "isolation.db") as (client, app):
        seed = await seed_chat(client)
        original = await _document(app, seed["segment"]["id"], "## 私有讲解\n秘密正文\n")
        target_id = original.id
        second_segment = await client.post(
            f"/api/sources/{seed['source']['id']}/segments", json={"text": "別の片段。"}
        )
        second_thread = await client.post(
            f"/api/segments/{second_segment.json()['id']}/threads",
            json={"request_id": str(uuid4())},
        )
        other = {**seed, "segment": second_segment.json(), "thread": second_thread.json()}
        job = await accept(client, other)
        await runtime.execute_job(app, job["id"])
        assert (await _job(client, job["id"]))["status"] == "succeeded"
        assert "404" in tool_output or "不属于当前片段" in tool_output
        assert "秘密正文" not in tool_output


@pytest.mark.asyncio
async def test_review_resume_keeps_shared_eight_call_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    count = 0
    document: Any = None
    resumed: list[dict[str, Any]] = []

    async def fake(
        snapshot: adapters.CallSnapshot,
        _key: str | None,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        tool_choice: str = "auto",
        on_progress: Any = None,
        on_tool_name: Any = None,
    ) -> adapters.ToolTurn:
        nonlocal count
        count += 1
        if count == 1:
            return _turn(
                snapshot,
                "先保存",
                [_call("save_analysis", {"source_md": "## 预算内成果\n已保存\n"}, "save_1")],
            )
        if count <= 6:
            return _turn(snapshot, "", [_call("list_analyses", {}, f"read_{count}")])
        if count == 7:
            return _turn(
                snapshot,
                "待审编辑",
                [
                    _call(
                        "update_analysis_section",
                        {
                            "analysis_id": document.id,
                            "base_revision_id": document.revision_id,
                            "sid": document.sections[1].uid,
                            "title": "新标题",
                        },
                        "edit_7",
                    )
                ],
            )
        resumed.extend(messages)
        return _turn(snapshot, "", [_call("list_analyses", {}, "read_8")])

    _install(monkeypatch, fake)
    database = tmp_path / "budget.db"
    async with chat_client(database) as (client, app):
        seed = await seed_chat(client)
        document = await _document(app, seed["segment"]["id"])
        job = await accept(client, seed)
        await runtime.execute_job(app, job["id"])
        waiting = await _job(client, job["id"])
        assert waiting["status"] == "waiting_review" and count == 7
        assert len(waiting["artifacts"]) == 1
        decided = await client.post(
            f"/api/jobs/{job['id']}/decision",
            json={
                "expected_version": waiting["version"],
                "decision": "reject",
                "additional_instructions": "保留原文",
            },
        )
        assert decided.status_code == 200
        await runtime.execute_job(app, job["id"])
        result = await _job(client, job["id"])
        assert result["status"] == "failed" and result["error_code"] == "budget_exhausted"
        assert len(result["artifacts"]) == 1
        assert count == 8
        assert "保留原文" in json.dumps(resumed, ensure_ascii=False)
        with sqlite3.connect(database) as connection:
            run_count = connection.execute(
                "SELECT count(*) FROM runs WHERE job_id=?", (job["id"],)
            ).fetchone()[0]
        assert run_count == 8
