"""Offline Analysis agent execution across chat, writing, edits and review."""

import asyncio
import json
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest
from httpx import AsyncClient
from test_chat_api import accept, chat_client, seed_chat

from app.jobs import runtime
from app.llm import adapters

DOCUMENT = "## 大意\n\n昨日は雨だった。\n\n## 语法\n\nだった是过去式。\n"


def call(name: str, args: dict[str, Any] | None = None, identity: str = "call_1") -> dict[str, str]:
    return {"id": identity, "name": name, "arguments": json.dumps(args or {}, ensure_ascii=False)}


def scripted_turn(
    monkeypatch: pytest.MonkeyPatch,
    script: list[tuple[str, list[dict[str, str]], bool]],
) -> list[dict[str, Any]]:
    captured: list[dict[str, Any]] = []

    async def complete(
        snapshot: adapters.CallSnapshot,
        key: str | None,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        tool_choice: str = "auto",
        on_progress: Callable[[str], Awaitable[None]] | None = None,
    ) -> adapters.ToolTurn:
        assert key == "fictional-chat-secret"
        assert script, "unexpected model call"
        text, calls, completed = script.pop(0)
        captured.append(
            {
                "snapshot": snapshot,
                "messages": json.loads(json.dumps(messages)),
                "tools": json.loads(json.dumps(tools)),
                "tool_choice": tool_choice,
            }
        )
        if on_progress and text:
            await on_progress(text)
        history: list[dict[str, Any]]
        if snapshot.protocol == "chat_completions":
            item: dict[str, Any] = {
                "role": "assistant",
                "content": text or None,
                "reasoning_content": "real-reasoning",
            }
            if calls:
                item["tool_calls"] = [
                    {
                        "id": entry["id"],
                        "type": "function",
                        "function": {
                            "name": entry["name"],
                            "arguments": entry["arguments"],
                        },
                    }
                    for entry in calls
                ]
            history = [item]
        else:
            history = [
                {"type": "reasoning", "id": f"r_{len(captured)}", "summary": []},
                *(
                    [
                        {
                            "type": "message",
                            "role": "assistant",
                            "content": [{"type": "output_text", "text": text}],
                        }
                    ]
                    if text
                    else []
                ),
                *[
                    {
                        "type": "function_call",
                        "call_id": entry["id"],
                        "name": entry["name"],
                        "arguments": entry["arguments"],
                    }
                    for entry in calls
                ],
            ]
        return adapters.ToolTurn(
            text=text,
            completed=completed,
            calls=calls,
            history_items=history if completed else [],
            usage=None,
            raw_response="{}",
        )

    monkeypatch.setattr(adapters, "complete_with_tools", complete)
    return captured


async def refreshed(client: AsyncClient, seed: dict[str, Any]) -> dict[str, Any]:
    return {
        **seed,
        "thread": (await client.get(f"/api/threads/{seed['thread']['id']}")).json(),
        "segment": (await client.get(f"/api/segments/{seed['segment']['id']}")).json(),
    }


async def quick_document(
    client: AsyncClient, app: Any, seed: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> tuple[dict[str, Any], dict[str, Any]]:
    scripted_turn(monkeypatch, [(DOCUMENT, [], True)])
    job = await accept(
        client,
        seed,
        action="generate_analysis",
        question="请为当前片段生成总体讲解。",
    )
    await runtime.execute_job(app, job["id"])
    result = (await client.get(f"/api/jobs/{job['id']}")).json()
    assert result["status"] == "succeeded"
    artifact = result["artifacts"][0]
    detail = (await client.get(f"/api/analyses/{artifact['analysis_id']}")).json()
    return result, detail


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol", ["chat_completions", "responses"])
async def test_quick_save_freezes_model_and_keeps_writer_out_of_next_chat(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    protocol: str,
) -> None:
    async with chat_client(tmp_path / "agent.db") as (client, app):
        seed = await seed_chat(client)
        if protocol == "responses":
            changed = await client.patch(
                f"/api/providers/{seed['provider']['id']}",
                json={"protocol": "responses"},
            )
            assert changed.status_code == 200, changed.text
        captured = scripted_turn(monkeypatch, [(DOCUMENT, [], True)])
        job = await accept(
            client,
            seed,
            action="generate_analysis",
            question="请为当前片段生成总体讲解。",
        )
        accepted = (await client.get(f"/api/jobs/{job['id']}")).json()
        await runtime.execute_job(app, job["id"])
        result = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert result["status"] == "succeeded"
        assert result["model"] == accepted["model"]
        assert result["artifacts"] and DOCUMENT not in result["assistant_message"]["content"]
        assert captured[0]["tool_choice"] == "none"
        assert captured[0]["snapshot"].model_id == result["model"]["model_id"]
        assert captured[0]["messages"][0]["role"] == "system"
        assert "大意" in captured[0]["messages"][-1]["content"]
        artifact = result["artifacts"][0]
        detail_response = await client.get(f"/api/analyses/{artifact['analysis_id']}")
        assert detail_response.status_code == 200, detail_response.text
        detail = detail_response.json()
        assert detail["revision_id"] == artifact["revision_id"]
        assert detail["source_md"] == DOCUMENT
        run = (await client.get(f"/api/runs/{result['run_id']}")).json()
        assert run["prompt_version"].endswith("+writer_v2")
        assert run["output_text"] == DOCUMENT

        second = await accept(
            client, await refreshed(client, seed), question="刚才的讲解说了什么？"
        )
        async with app.state.session_factory() as session:
            from app.chat_models import Job

            frozen = await session.get(Job, second["id"])
            assert frozen is not None
            history = frozen.input_snapshot["messages"]
        assert not any(DOCUMENT in json.dumps(item, ensure_ascii=False) for item in history)
        assert not any(
            "先给学习者一眼能把握" in json.dumps(item, ensure_ascii=False) for item in history
        )
        assert any(artifact["analysis_id"] in json.dumps(item) for item in history)
        assert not any(item.get("role") == "assistant" for item in history)


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol", ["chat_completions", "responses"])
@pytest.mark.parametrize(
    ("title", "expected_title"),
    [
        (None, "大意"),
        ("  だった的过去状态  ", "だった的过去状态"),
        ("  か\u3099ち的用法  ", "がち的用法"),
        ("题" * 200, "题" * 200),
    ],
)
async def test_native_generate_branch_reuses_parent_prefix_and_returns_identity(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    protocol: str,
    title: str | None,
    expected_title: str,
) -> None:
    async with chat_client(tmp_path / "agent.db") as (client, app):
        seed = await seed_chat(client)
        if protocol == "responses":
            changed = await client.patch(
                f"/api/providers/{seed['provider']['id']}", json={"protocol": protocol}
            )
            assert changed.status_code == 200
        captured = scripted_turn(
            monkeypatch,
            [
                ("", [call("generate_analysis", {"title": title} if title else {})], True),
                (DOCUMENT, [], True),
                ("已经为你保存讲解。", [], True),
            ],
        )
        job = await accept(client, seed, question="整理成总体讲解并保存")
        await runtime.execute_job(app, job["id"])
        result = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert result["status"] == "succeeded"
        assert len(result["runs"]) == 3
        assert result["artifacts"]
        detail = (await client.get(f"/api/analyses/{result['artifacts'][0]['analysis_id']}")).json()
        assert detail["title"] == expected_title
        assert detail["source_md"] == DOCUMENT
        parent, branch, follow = captured
        assert parent["snapshot"].model_id == branch["snapshot"].model_id
        assert parent["snapshot"].protocol == branch["snapshot"].protocol
        assert parent["snapshot"].temperature == branch["snapshot"].temperature
        assert parent["snapshot"].max_output_tokens == branch["snapshot"].max_output_tokens
        assert parent["snapshot"].reasoning_effort == branch["snapshot"].reasoning_effort
        assert parent["tools"] == branch["tools"] == follow["tools"]
        assert branch["tool_choice"] == "none"
        assert branch["messages"][: len(parent["messages"])] == parent["messages"]
        native_call = branch["messages"][len(parent["messages"]) : -2]
        assert any(
            item.get("role") == "assistant" or item.get("type") == "function_call"
            for item in native_call
        )
        tool_result = branch["messages"][-2]
        assert (
            tool_result.get("role") == "tool" or tool_result.get("type") == "function_call_output"
        )
        assert branch["messages"][-1]["role"] == "user"
        assert "先给学习者一眼能把握" in branch["messages"][-1]["content"]
        assert not any(
            DOCUMENT in json.dumps(item, ensure_ascii=False) for item in follow["messages"]
        )
        assert not any(
            "先给学习者一眼能把握" in json.dumps(item, ensure_ascii=False)
            for item in follow["messages"]
        )
        assert result["artifacts"][0]["analysis_id"] in json.dumps(follow["messages"])
        assert expected_title in json.dumps(follow["messages"], ensure_ascii=False)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "args",
    [
        {"title": ""},
        {"title": "  "},
        {"title": "题" * 201},
        {"title": None},
        {"title": 123},
        {"title": "主题", "body": "正文"},
    ],
)
async def test_generate_rejects_invalid_title_before_starting_writer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, args: dict[str, Any]
) -> None:
    async with chat_client(tmp_path / "invalid-title.db") as (client, app):
        seed = await seed_chat(client)
        captured = scripted_turn(
            monkeypatch,
            [("", [call("generate_analysis", args)], True), ("标题参数无效。", [], True)],
        )
        job = await accept(client, seed, question="请生成讲解")
        await runtime.execute_job(app, job["id"])
        result = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert result["status"] == "succeeded"
        assert result["artifacts"] == []
        assert len(result["runs"]) == len(captured) == 2
        assert json.loads(captured[1]["messages"][-1]["content"])["error"]
        assert (await client.get(f"/api/segments/{seed['segment']['id']}/analyses")).json() == []


@pytest.mark.asyncio
async def test_full_access_edit_preserves_old_revision_and_read_tool_is_bounded(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with chat_client(tmp_path / "agent.db") as (client, app):
        seed = await seed_chat(client)
        _, detail = await quick_document(client, app, seed, monkeypatch)
        seed = await refreshed(client, seed)
        patched = await client.patch(
            f"/api/threads/{seed['thread']['id']}",
            json={
                "expected_revision": seed["thread"]["revision"],
                "permission_mode": "full_access",
            },
        )
        assert patched.status_code == 200, patched.text
        seed = await refreshed(client, seed)
        sid = next(row["uid"] for row in detail["sections"] if row["title"] == "语法")
        captured = scripted_turn(
            monkeypatch,
            [
                (
                    "",
                    [
                        call(
                            "read_analysis",
                            {
                                "analysis_id": detail["id"],
                                "revision_id": detail["revision_id"],
                                "section_ids": [sid],
                            },
                        )
                    ],
                    True,
                ),
                (
                    "",
                    [
                        call(
                            "update_analysis_section",
                            {
                                "analysis_id": detail["id"],
                                "base_revision_id": detail["revision_id"],
                                "sid": sid,
                                "title": "活用",
                            },
                            "call_2",
                        )
                    ],
                    True,
                ),
                ("已更新语法说明。", [], True),
            ],
        )
        job = await accept(client, seed, question="读取并修改语法节")
        await runtime.execute_job(app, job["id"])
        result = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert result["status"] == "succeeded"
        assert len(result["runs"]) == 3
        assert len(result["artifacts"]) == 1
        assert result["artifacts"][0]["analysis_id"] == detail["id"]
        assert result["artifacts"][0]["revision_id"] != detail["revision_id"]
        read_output = json.loads(captured[1]["messages"][-1]["content"])
        assert "source_md" not in read_output
        assert len(read_output["sections"]) == 1
        assert read_output["sections"][0]["uid"] == sid
        old = (
            await client.get(f"/api/analyses/{detail['id']}?revision_id={detail['revision_id']}")
        ).json()
        current = (await client.get(f"/api/analyses/{detail['id']}")).json()
        assert old["source_md"] == DOCUMENT
        assert "## 活用" in current["source_md"]
        assert "だった是过去式。" in current["source_md"]
        assert next(row for row in current["sections"] if row["title"] == "活用")["uid"] == sid
        assert current["run_id"] == result["runs"][1]["id"]


@pytest.mark.asyncio
async def test_review_approve_reject_and_revision_request_are_exact_and_idempotent(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with chat_client(tmp_path / "agent.db") as (client, app):
        seed = await seed_chat(client)
        _, detail = await quick_document(client, app, seed, monkeypatch)
        sid = next(row["uid"] for row in detail["sections"] if row["title"] == "语法")
        seed = await refreshed(client, seed)
        edit_args = {
            "analysis_id": detail["id"],
            "base_revision_id": detail["revision_id"],
            "sid": sid,
            "title": "活用",
            "body": "过去式。",
        }
        scripted_turn(
            monkeypatch,
            [
                ("", [call("update_analysis_section", edit_args)], True),
                ("已按审核应用。", [], True),
            ],
        )
        job = await accept(client, seed, question="把语法节修改后请我审核")
        await runtime.execute_job(app, job["id"])
        pending = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert pending["status"] == "waiting_review"
        assert pending["review_proposal"]["analysis_id"] == detail["id"]
        assert pending["review_proposal"]["base_revision_id"] == detail["revision_id"]
        assert pending["review_proposal"]["before"].startswith("## 语法")
        assert pending["review_proposal"]["after"].startswith("## 活用")
        assert pending["review_proposal"]["source_run_id"] == pending["run_id"]
        assert (await client.get(f"/api/analyses/{detail['id']}")).json()["revision_id"] == detail[
            "revision_id"
        ]
        body = {"expected_version": pending["version"], "decision": "approve"}
        accepted = await client.post(f"/api/jobs/{job['id']}/decision", json=body)
        assert accepted.status_code == 200, accepted.text
        replay = await client.post(f"/api/jobs/{job['id']}/decision", json=body)
        assert replay.status_code == 200
        assert replay.json()["version"] == accepted.json()["version"]
        conflict = await client.post(
            f"/api/jobs/{job['id']}/decision", json={**body, "decision": "reject"}
        )
        assert conflict.status_code == 409
        await runtime.execute_job(app, job["id"])
        complete = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert complete["status"] == "succeeded"
        assert complete["artifacts"][0]["revision_id"] != detail["revision_id"]
        assert (await client.get(f"/api/analyses/{detail['id']}")).json()["run_id"] == pending[
            "run_id"
        ]

        current = (await client.get(f"/api/analyses/{detail['id']}")).json()
        seed = await refreshed(client, seed)
        reject_args = {
            "analysis_id": detail["id"],
            "base_revision_id": current["revision_id"],
            "sid": sid,
        }
        captured = scripted_turn(
            monkeypatch,
            [
                ("", [call("delete_analysis_section", reject_args, "call_reject")], True),
                ("已撤销这次删除。", [], True),
            ],
        )
        rejected_job = await accept(client, seed, question="删掉这一节，但先审核")
        await runtime.execute_job(app, rejected_job["id"])
        waiting = (await client.get(f"/api/jobs/{rejected_job['id']}")).json()
        decision = await client.post(
            f"/api/jobs/{rejected_job['id']}/decision",
            json={
                "expected_version": waiting["version"],
                "decision": "reject",
                "additional_instructions": "保留这一节",
            },
        )
        assert decision.status_code == 200
        await runtime.execute_job(app, rejected_job["id"])
        assert json.loads(captured[-1]["messages"][-1]["content"])["status"] == "rejected"
        assert (await client.get(f"/api/analyses/{detail['id']}")).json()["revision_id"] == current[
            "revision_id"
        ]

        seed = await refreshed(client, seed)
        scripted_turn(
            monkeypatch,
            [
                ("", [call("delete_analysis_section", reject_args, "call_rev")], True),
                ("收到补充要求，我会重新提案。", [], True),
            ],
        )
        revise_job = await accept(client, seed, question="重新考虑删节，先审核")
        await runtime.execute_job(app, revise_job["id"])
        waiting = (await client.get(f"/api/jobs/{revise_job['id']}")).json()
        decision = await client.post(
            f"/api/jobs/{revise_job['id']}/decision",
            json={
                "expected_version": waiting["version"],
                "decision": "approve",
                "additional_instructions": "先保留，改写内容",
            },
        )
        assert decision.status_code == 200
        await runtime.execute_job(app, revise_job["id"])
        assert (await client.get(f"/api/analyses/{detail['id']}")).json()["revision_id"] == current[
            "revision_id"
        ]


@pytest.mark.asyncio
async def test_legacy_and_protocol_switch_history_is_material_not_fake_assistant(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from sqlalchemy import text

    from app.chat_models import Job

    async with chat_client(tmp_path / "agent.db") as (client, app):
        seed = await seed_chat(client)
        scripted_turn(monkeypatch, [("旧版可见答案", [], True)])
        first = await accept(client, seed, additional_instructions="旧轮补充要求")
        await runtime.execute_job(app, first["id"])
        async with app.state.session_factory() as session:
            await session.execute(text("BEGIN IMMEDIATE"))
            await session.execute(
                text("UPDATE chat_jobs SET execution_state='{}' WHERE id=:id"),
                {"id": first["id"]},
            )
            await session.commit()
        second = await accept(client, await refreshed(client, seed), question="继续旧版讨论")
        async with app.state.session_factory() as session:
            frozen = await session.get(Job, second["id"])
            assert frozen is not None
            snapshot = frozen.input_snapshot
        assert snapshot["legacy_history_conversion"] == "history_material_v1"
        assert [item["role"] for item in snapshot["messages"]] == ["system", "user", "user"]
        assert "旧版可见答案" in snapshot["messages"][1]["content"]
        assert "旧轮补充要求" in snapshot["messages"][1]["content"]

    async with chat_client(tmp_path / "switch.db") as (client, app):
        seed = await seed_chat(client)
        changed = await client.patch(
            f"/api/providers/{seed['provider']['id']}", json={"protocol": "responses"}
        )
        assert changed.status_code == 200
        scripted_turn(monkeypatch, [("Responses 可见答案", [], True)])
        first = await accept(client, seed, question="先回答")
        await runtime.execute_job(app, first["id"])
        changed = await client.patch(
            f"/api/providers/{seed['provider']['id']}", json={"protocol": "chat_completions"}
        )
        assert changed.status_code == 200
        second = await accept(client, await refreshed(client, seed), question="切换后继续")
        async with app.state.session_factory() as session:
            frozen = await session.get(Job, second["id"])
            assert frozen is not None
            snapshot = frozen.input_snapshot
        assert snapshot["protocol_conversion"]["strategy"] == "history_material_v1"
        assert [item["role"] for item in snapshot["messages"]] == ["system", "user", "user"]
        assert "Responses 可见答案" in snapshot["messages"][1]["content"]
        assert "reasoning" not in snapshot["messages"][1]["content"]


@pytest.mark.asyncio
async def test_eight_call_budget_is_shared_by_tool_loop(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with chat_client(tmp_path / "budget.db") as (client, app):
        seed = await seed_chat(client)
        calls = [
            ("", [call("list_analyses", identity=f"call_{index}")], True) for index in range(8)
        ]
        captured = scripted_turn(monkeypatch, calls)
        job = await accept(client, seed, question="检查讲解清单")
        await runtime.execute_job(app, job["id"])
        result = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert result["status"] == "failed"
        assert result["error_code"] == "budget_exhausted"
        assert len(captured) == len(result["runs"]) == 8
        assert not calls
        assert result["artifacts"] == []


@pytest.mark.asyncio
async def test_saved_branch_survives_parent_failure_and_next_turn_gets_identity(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with chat_client(tmp_path / "partial.db") as (client, app):
        seed = await seed_chat(client)
        scripted_turn(
            monkeypatch,
            [
                ("", [call("generate_analysis")], True),
                (DOCUMENT, [], True),
                ("残缺主回复", [], False),
            ],
        )
        job = await accept(client, seed, question="生成总体讲解并保存")
        await runtime.execute_job(app, job["id"])
        result = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert result["status"] == "failed"
        artifact = result["artifacts"][0]
        assert (await client.get(f"/api/analyses/{artifact['analysis_id']}")).json()[
            "revision_id"
        ] == artifact["revision_id"]
        second = await accept(client, await refreshed(client, seed), question="继续修改刚才那份")
        from app.chat_models import Job

        async with app.state.session_factory() as session:
            frozen = await session.get(Job, second["id"])
            assert frozen is not None
            history = frozen.input_snapshot["messages"]
        assert any(artifact["analysis_id"] in json.dumps(item) for item in history)
        assert not any("残缺主回复" in json.dumps(item) for item in history)
        assert not any(DOCUMENT in json.dumps(item, ensure_ascii=False) for item in history)


@pytest.mark.asyncio
async def test_stop_fences_quick_save_even_when_model_returns_late(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = asyncio.Event()
    release = asyncio.Event()
    entries = 0

    async def late(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        tool_choice: str = "auto",
        on_progress: Callable[[str], Awaitable[None]] | None = None,
    ) -> adapters.ToolTurn:
        nonlocal entries
        entries += 1
        assert messages and tools and tool_choice == "none"
        started.set()
        while not release.is_set():
            try:
                await release.wait()
            except asyncio.CancelledError:
                pass
        return adapters.ToolTurn(
            text=DOCUMENT,
            completed=True,
            calls=[],
            history_items=[{"role": "assistant", "content": DOCUMENT}],
            usage=None,
            raw_response="{}",
        )

    monkeypatch.setattr(adapters, "complete_with_tools", late)
    async with chat_client(tmp_path / "stop.db") as (client, app):
        seed = await seed_chat(client)
        job = await accept(client, seed, action="generate_analysis", question="生成总体讲解")
        task = asyncio.create_task(runtime.execute_job(app, job["id"]))
        try:
            await asyncio.wait_for(started.wait(), timeout=2)
            stopped = await client.post(f"/api/jobs/{job['id']}/stop")
            assert stopped.status_code == 200
            state: dict[str, Any] = stopped.json()
            for _ in range(50):
                state = (await client.get(f"/api/jobs/{job['id']}")).json()
                if state["status"] == "interrupted":
                    break
                await asyncio.sleep(0.01)
            assert state["status"] == "interrupted"
            assert state["artifacts"] == []
            assert entries == 1
        finally:
            release.set()
            await asyncio.wait_for(task, timeout=2)
        final = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert final["status"] == "interrupted"
        listed = (await client.get(f"/api/segments/{seed['segment']['id']}/analyses")).json()
        assert listed == []


@pytest.mark.asyncio
async def test_waiting_review_survives_recovery_and_can_be_stopped(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with chat_client(tmp_path / "review.db") as (client, app):
        seed = await seed_chat(client)
        _, detail = await quick_document(client, app, seed, monkeypatch)
        sid = next(row["uid"] for row in detail["sections"] if row["title"] == "语法")
        scripted_turn(
            monkeypatch,
            [
                (
                    "",
                    [
                        call(
                            "delete_analysis_section",
                            {
                                "analysis_id": detail["id"],
                                "base_revision_id": detail["revision_id"],
                                "sid": sid,
                            },
                        )
                    ],
                    True,
                )
            ],
        )
        job = await accept(client, await refreshed(client, seed), question="删节前审核")
        await runtime.execute_job(app, job["id"])
        waiting = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert waiting["status"] == "waiting_review"
        async with app.state.session_factory() as session:
            await runtime.recover_chat_jobs(session)
        preserved = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert preserved["status"] == "waiting_review"
        stopped = await client.post(f"/api/jobs/{job['id']}/stop")
        assert stopped.status_code == 200
        assert stopped.json()["status"] == "interrupted"
        assert (await client.get(f"/api/analyses/{detail['id']}")).json()["revision_id"] == detail[
            "revision_id"
        ]


@pytest.mark.asyncio
async def test_full_access_insert_delete_and_preamble_each_make_new_revision(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with chat_client(tmp_path / "sections.db") as (client, app):
        seed = await seed_chat(client)
        _, detail = await quick_document(client, app, seed, monkeypatch)
        seed = await refreshed(client, seed)
        patched = await client.patch(
            f"/api/threads/{seed['thread']['id']}",
            json={
                "expected_revision": seed["thread"]["revision"],
                "permission_mode": "full_access",
            },
        )
        assert patched.status_code == 200
        source_id = detail["id"]
        base = detail["revision_id"]
        after_sid = next(row["uid"] for row in detail["sections"] if row["title"] == "大意")
        operations = [
            (
                "insert_analysis_sections",
                {
                    "analysis_id": source_id,
                    "base_revision_id": base,
                    "after_sid": after_sid,
                    "sections": [{"title": "例句", "body": "昨日は雨だった。"}],
                },
            ),
        ]
        revisions = [base]
        for tool_name, args in operations:
            seed = await refreshed(client, seed)
            scripted_turn(
                monkeypatch,
                [
                    ("", [call(tool_name, args)], True),
                    ("操作已完成。", [], True),
                ],
            )
            job = await accept(client, seed, question="编辑讲解")
            await runtime.execute_job(app, job["id"])
            result = (await client.get(f"/api/jobs/{job['id']}")).json()
            assert result["status"] == "succeeded"
            revisions.append(result["artifacts"][0]["revision_id"])
        current = (await client.get(f"/api/analyses/{source_id}")).json()
        inserted_sid = next(row["uid"] for row in current["sections"] if row["title"] == "例句")
        for tool_name, args in [
            (
                "delete_analysis_section",
                {
                    "analysis_id": source_id,
                    "base_revision_id": revisions[-1],
                    "sid": inserted_sid,
                },
            ),
            (
                "update_analysis_preamble",
                {
                    "analysis_id": source_id,
                    "base_revision_id": "CURRENT",
                    "body": "这是总述。\n",
                },
            ),
        ]:
            if args["base_revision_id"] == "CURRENT":
                args["base_revision_id"] = revisions[-1]
            seed = await refreshed(client, seed)
            scripted_turn(
                monkeypatch,
                [
                    ("", [call(tool_name, args)], True),
                    ("操作已完成。", [], True),
                ],
            )
            job = await accept(client, seed, question="继续编辑讲解")
            await runtime.execute_job(app, job["id"])
            result = (await client.get(f"/api/jobs/{job['id']}")).json()
            assert result["status"] == "succeeded"
            revisions.append(result["artifacts"][0]["revision_id"])
        assert len(set(revisions)) == 4
        current = (await client.get(f"/api/analyses/{source_id}")).json()
        assert current["revision_id"] == revisions[-1]
        assert current["source_md"].startswith("这是总述。")
        assert "## 例句" not in current["source_md"]
        first = (await client.get(f"/api/analyses/{source_id}?revision_id={base}")).json()
        assert first["source_md"] == DOCUMENT


@pytest.mark.asyncio
async def test_stop_after_branch_save_retains_artifact_and_continuation_fact(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with chat_client(tmp_path / "saved-stop.db") as (client, app):
        seed = await seed_chat(client)
        captured = scripted_turn(
            monkeypatch,
            [
                ("", [call("generate_analysis")], True),
                (DOCUMENT, [], True),
                ("迟到的主回复", [], True),
            ],
        )
        base = adapters.complete_with_tools
        started = asyncio.Event()
        release = asyncio.Event()

        async def delayed(
            snapshot: adapters.CallSnapshot,
            key: str | None,
            *,
            messages: list[dict[str, Any]],
            tools: list[dict[str, Any]],
            tool_choice: str = "auto",
            on_progress: Callable[[str], Awaitable[None]] | None = None,
        ) -> adapters.ToolTurn:
            if len(captured) == 2:
                started.set()
                while not release.is_set():
                    try:
                        await release.wait()
                    except asyncio.CancelledError:
                        pass
            return await base(
                snapshot,
                key,
                messages=messages,
                tools=tools,
                tool_choice=tool_choice,
                on_progress=on_progress,
            )

        monkeypatch.setattr(adapters, "complete_with_tools", delayed)
        job = await accept(client, seed, question="生成并保存讲解")
        task = asyncio.create_task(runtime.execute_job(app, job["id"]))
        try:
            await asyncio.wait_for(started.wait(), timeout=2)
            saved = (await client.get(f"/api/jobs/{job['id']}")).json()
            artifact = saved["artifacts"][0]
            stopped = await client.post(f"/api/jobs/{job['id']}/stop")
            assert stopped.status_code == 200
            state: dict[str, Any] = stopped.json()
            for _ in range(50):
                state = (await client.get(f"/api/jobs/{job['id']}")).json()
                if state["status"] == "interrupted":
                    break
                await asyncio.sleep(0.01)
            assert state["status"] == "interrupted"
            assert state["artifacts"] == [artifact]
        finally:
            release.set()
            await asyncio.wait_for(task, timeout=2)
        assert (await client.get(f"/api/analyses/{artifact['analysis_id']}")).json()[
            "revision_id"
        ] == artifact["revision_id"]
        second = await accept(client, await refreshed(client, seed), question="继续改这份")
        from app.chat_models import Job

        async with app.state.session_factory() as session:
            frozen = await session.get(Job, second["id"])
            assert frozen is not None
            history = frozen.input_snapshot["messages"]
        assert any(artifact["analysis_id"] in json.dumps(item) for item in history)
        assert not any("迟到的主回复" in json.dumps(item) for item in history)


@pytest.mark.asyncio
async def test_responses_native_branch_replays_output_items_without_previous_response_id(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with chat_client(tmp_path / "responses-branch.db") as (client, app):
        seed = await seed_chat(client)
        changed = await client.patch(
            f"/api/providers/{seed['provider']['id']}", json={"protocol": "responses"}
        )
        assert changed.status_code == 200
        captured = scripted_turn(
            monkeypatch,
            [
                ("", [call("generate_analysis")], True),
                (DOCUMENT, [], True),
                ("已保存。", [], True),
            ],
        )
        job = await accept(client, seed, question="生成并保存总体讲解")
        await runtime.execute_job(app, job["id"])
        result = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert result["status"] == "succeeded"
        assert len(result["runs"]) == 3
        parent, branch, follow = captured
        assert branch["messages"][: len(parent["messages"])] == parent["messages"]
        continuation = branch["messages"][len(parent["messages"]) :]
        assert [item["type"] for item in continuation[:3]] == [
            "reasoning",
            "function_call",
            "function_call_output",
        ]
        assert continuation[-1]["role"] == "user"
        assert branch["tool_choice"] == "none"
        assert parent["tools"] == branch["tools"] == follow["tools"]
        assert not any(
            DOCUMENT in json.dumps(item, ensure_ascii=False) for item in follow["messages"]
        )
        assert result["artifacts"][0]["analysis_id"] in json.dumps(follow["messages"])
