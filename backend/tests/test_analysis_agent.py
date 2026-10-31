"""Offline Analysis agent execution across chat, writing, edits and review."""

import asyncio
import json
import sqlite3
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from httpx import AsyncClient
from support_api import accept, chat_client, seed_chat

from app.analysis_schemas import SectionOperation
from app.jobs import runtime
from app.llm import adapters
from app.services import analyses
from app.services.sources import begin_write

DOCUMENT_BODY_MARKER = "だった是过去式。"
DOCUMENT = f"## 大意\n\n昨日は雨だった。\n\n## 语法\n\n{DOCUMENT_BODY_MARKER}\n"


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


async def saved_document(
    client: AsyncClient,
    app: Any,
    seed: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
    source_md: str = DOCUMENT,
) -> tuple[dict[str, Any], dict[str, Any]]:
    scripted_turn(
        monkeypatch,
        [("", [call("save_analysis", {"source_md": source_md})], True), ("已保存讲解。", [], True)],
    )
    job = await accept(
        client,
        seed,
        question="请为当前片段生成并保存总体讲解。",
    )
    await runtime.execute_job(app, job["id"])
    result = (await client.get(f"/api/jobs/{job['id']}")).json()
    assert result["status"] == "succeeded"
    artifact = result["artifacts"][0]
    detail = (await client.get(f"/api/analyses/{artifact['analysis_id']}")).json()
    return result, detail


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol", ["chat_completions", "responses"])
async def test_ordinary_explanation_replies_without_creating_analysis(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    protocol: str,
) -> None:
    async with chat_client(tmp_path / "agent.db") as (client, app):
        seed = await seed_chat(client)
        if protocol == "responses":
            assert (
                await client.patch(
                    f"/api/providers/{seed['provider']['id']}", json={"protocol": protocol}
                )
            ).status_code == 200
        captured = scripted_turn(monkeypatch, [(DOCUMENT, [], True), ("后续回答", [], True)])
        first = await accept(client, seed, question="请解释当前片段")
        await runtime.execute_job(app, first["id"])
        result = (await client.get(f"/api/jobs/{first['id']}")).json()
        assert result["kind"] == "chat"
        assert result["status"] == "succeeded"
        assert result["assistant_message"]["content"] == DOCUMENT
        assert result["artifacts"] == []
        assert len(result["runs"]) == 1
        assert (await client.get(f"/api/segments/{seed['segment']['id']}/analyses")).json() == []
        second = await accept(client, await refreshed(client, seed), question="继续讨论")
        await runtime.execute_job(app, second["id"])
        assert len(captured) == 2
        assert DOCUMENT_BODY_MARKER in json.dumps(captured[1]["messages"], ensure_ascii=False)


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol", ["chat_completions", "responses"])
async def test_create_explanation_shortcut_saves_through_the_ordinary_agent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, protocol: str
) -> None:
    async with chat_client(tmp_path / "shortcut.db") as (client, app):
        seed = await seed_chat(client)
        if protocol == "responses":
            changed = await client.patch(
                f"/api/providers/{seed['provider']['id']}", json={"protocol": protocol}
            )
            assert changed.status_code == 200, changed.text
        prompt = await client.get("/api/chat/explanation-prompt")
        assert prompt.status_code == 200, prompt.text
        question = prompt.json()["question"]
        created = await client.post(
            f"/api/segments/{seed['segment']['id']}/threads",
            json={"request_id": str(uuid4()), "model_id": seed["model"]["id"]},
        )
        assert created.status_code == 201, created.text
        thread = created.json()
        assert thread["id"] != seed["thread"]["id"]
        captured = scripted_turn(
            monkeypatch,
            [
                ("", [call("save_analysis", {"source_md": DOCUMENT, "title": "片段讲解"})], True),
                ("已保存《片段讲解》。", [], True),
            ],
        )
        job = await accept(client, {**seed, "thread": thread}, question=question)
        await runtime.execute_job(app, job["id"])
        result = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert result["kind"] == "chat" and result["status"] == "succeeded"
        assert result["question"] == question
        assert len(result["runs"]) == len(captured) == 2
        assert {run["purpose"] for run in result["runs"]} == {"chat"}
        assert all(turn["tool_choice"] == "auto" for turn in captured)
        assert captured[0]["tools"] == captured[1]["tools"]
        assert question in captured[0]["messages"][-1]["content"]
        assert len(result["artifacts"]) == 1
        artifact = result["artifacts"][0]
        output = captured[1]["messages"][-1]
        body = output["content"] if protocol == "chat_completions" else output["output"]
        assert json.loads(body) == {"status": "saved", "title": "片段讲解", **artifact}
        detail = (
            await client.get(
                f"/api/analyses/{artifact['analysis_id']}",
                params={"revision_id": artifact["revision_id"]},
            )
        ).json()
        assert detail["source_md"] == DOCUMENT and detail["title"] == "片段讲解"
        listed = (await client.get(f"/api/segments/{seed['segment']['id']}/analyses")).json()
        assert [item["id"] for item in listed] == [artifact["analysis_id"]]
        assert result["assistant_message"]["content"] == "已保存《片段讲解》。"
        assert DOCUMENT_BODY_MARKER not in result["assistant_message"]["content"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("protocol", "title", "expected_title"),
    [
        ("chat_completions", None, "大意"),
        ("responses", None, "大意"),
        ("chat_completions", "  だった的过去状态  ", "だった的过去状态"),
        ("chat_completions", "  か\u3099ち的用法  ", "がち的用法"),
        ("chat_completions", "题" * 200, "题" * 200),
    ],
)
async def test_native_save_uses_argument_markdown_and_returns_identity(
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
        args = {"source_md": DOCUMENT, **({"title": title} if title is not None else {})}
        captured = scripted_turn(
            monkeypatch,
            [
                ("", [call("save_analysis", args)], True),
                ("已经为你保存讲解。", [], True),
            ],
        )
        job = await accept(client, seed, question="整理成总体讲解并保存")
        await runtime.execute_job(app, job["id"])
        result = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert result["status"] == "succeeded"
        assert len(result["runs"]) == len(captured) == 2
        assert {run["purpose"] for run in result["runs"]} == {"chat"}
        artifact = result["artifacts"][0]
        detail = (await client.get(f"/api/analyses/{artifact['analysis_id']}")).json()
        assert detail["title"] == expected_title
        assert detail["source_md"] == DOCUMENT
        parent, follow = captured
        assert parent["tools"] == follow["tools"]
        assert parent["tool_choice"] == follow["tool_choice"] == "auto"
        assert follow["messages"][: len(parent["messages"])] == parent["messages"]
        output = follow["messages"][-1]
        body = output["content"] if protocol == "chat_completions" else output["output"]
        assert json.loads(body) == {"status": "saved", "title": expected_title, **artifact}
        assert DOCUMENT_BODY_MARKER in json.dumps(follow["messages"], ensure_ascii=False)
        assert result["assistant_message"]["content"] == "已经为你保存讲解。"
        with sqlite3.connect(tmp_path / "agent.db") as connection:
            rows = connection.execute(
                "SELECT id,purpose,output_text FROM runs WHERE job_id=? ORDER BY created_at,id",
                (job["id"],),
            ).fetchall()
            revision_run_id = connection.execute(
                "SELECT run_id FROM analysis_revisions WHERE id=?", (artifact["revision_id"],)
            ).fetchone()[0]
        assert [row[1] for row in rows] == ["chat", "chat"]
        assert [row[2] for row in rows] == ["", "已经为你保存讲解。"]
        assert revision_run_id == rows[0][0]


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
        {"source_md": ""},
        {"source_md": "  "},
        {"source_md": 123},
    ],
    ids=[
        "empty-title",
        "blank-title",
        "long-title",
        "null-title",
        "number-title",
        "extra-field",
        "empty-body",
        "blank-body",
        "number-body",
    ],
)
async def test_save_rejects_invalid_title_without_creating_analysis(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, args: dict[str, Any]
) -> None:
    async with chat_client(tmp_path / "invalid-title.db") as (client, app):
        seed = await seed_chat(client)
        captured = scripted_turn(
            monkeypatch,
            [
                ("", [call("save_analysis", {"source_md": DOCUMENT, **args})], True),
                ("标题参数无效。", [], True),
            ],
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
        _, detail = await saved_document(client, app, seed, monkeypatch)
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
async def test_review_approve_reject_and_followup_are_exact_and_idempotent(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with chat_client(tmp_path / "agent.db") as (client, app):
        seed = await seed_chat(client)
        _, detail = await saved_document(client, app, seed, monkeypatch)
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
        captured = scripted_turn(
            monkeypatch,
            [
                ("", [call("delete_analysis_section", reject_args, "call_rev")], True),
                ("已删除获批节，后续修改需要重新提案。", [], True),
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
        updated = (await client.get(f"/api/analyses/{detail['id']}")).json()
        assert updated["revision_id"] != current["revision_id"]
        assert all(row["uid"] != sid for row in updated["sections"])
        feedback = json.loads(captured[-1]["messages"][-1]["content"])
        assert feedback["status"] == "saved"
        assert feedback["revision_id"] == updated["revision_id"]
        assert feedback["additional_instructions"] == "先保留，改写内容"
        replay = await client.post(
            f"/api/jobs/{revise_job['id']}/decision",
            json={
                "expected_version": waiting["version"],
                "decision": "approve",
                "additional_instructions": "先保留，改写内容",
            },
        )
        assert replay.status_code == 200
        await runtime.execute_job(app, revise_job["id"])
        assert (await client.get(f"/api/analyses/{detail['id']}")).json() == updated


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
        first = await accept(client, seed)
        async with app.state.session_factory() as session:
            old = await session.get(Job, first["id"])
            assert old is not None
            old.input_snapshot = {
                **old.input_snapshot,
                "additional_instructions": "旧轮补充要求",
                "messages": [
                    {"role": "system", "content": "旧规则"},
                    {"role": "user", "content": "旧问题\n本轮补充要求：旧轮补充要求"},
                ],
            }
            await session.commit()
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
        assert [item["role"] for item in snapshot["messages"]] == ["system", "user", "user", "user"]
        assert "旧版可见答案" in snapshot["messages"][1]["content"]
        assert "旧轮补充要求" in snapshot["messages"][1]["content"]
        assert "昨日は雨だった。" in snapshot["messages"][-2]["content"]
        assert "继续旧版讨论" in snapshot["messages"][-1]["content"]

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
        assert [item["role"] for item in snapshot["messages"]] == ["system", "user", "user", "user"]
        assert "Responses 可见答案" in snapshot["messages"][1]["content"]
        assert "reasoning" not in snapshot["messages"][1]["content"]
        assert "昨日は雨だった。" in snapshot["messages"][-2]["content"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line_ending,terminated",
    [("\n", True), ("\r\n", True), ("\r", True), ("\n", False)],
)
async def test_reviewed_insert_preview_matches_saved_markdown_across_line_endings(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    line_ending: str,
    terminated: bool,
) -> None:
    source_md = DOCUMENT.replace("\n", line_ending)
    if not terminated:
        source_md = source_md.removesuffix(line_ending)
    async with chat_client(tmp_path / "preview-save.db") as (client, app):
        seed = await seed_chat(client)
        _, document = await saved_document(client, app, seed, monkeypatch, source_md)
        args = {
            "analysis_id": document["id"],
            "base_revision_id": document["revision_id"],
            "after_sid": document["sections"][1]["uid"],
            "sections": [{"title": "  は\u3099  ", "body": "は\u3099"}],
        }
        scripted_turn(
            monkeypatch,
            [
                ("", [call("insert_analysis_sections", args, "preview_insert")], True),
                ("已完成。", [], True),
            ],
        )
        job = await accept(client, await refreshed(client, seed), question="审核这次插入")
        await runtime.execute_job(app, job["id"])
        waiting = (await client.get(f"/api/jobs/{job['id']}")).json()
        proposal = waiting["review_proposal"]
        assert waiting["status"] == "waiting_review"
        approved = await client.post(
            f"/api/jobs/{job['id']}/decision",
            json={"expected_version": waiting["version"], "decision": "approve"},
        )
        assert approved.status_code == 200
        await runtime.execute_job(app, job["id"])
        saved = (await client.get(f"/api/analyses/{document['id']}")).json()
        assert (
            next(section["raw"] for section in saved["sections"] if section["title"] == "ば")
            == (proposal["after"])
            == "## ば\n\nば\n"
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("source_md", "body", "expected"),
    [(DOCUMENT, "", ""), ("仅有总述", "新的总述", "新的总述\n")],
)
async def test_reviewed_preamble_preview_matches_saved_empty_and_no_h2_documents(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    source_md: str,
    body: str,
    expected: str,
) -> None:
    async with chat_client(tmp_path / "preamble-preview.db") as (client, app):
        seed = await seed_chat(client)
        _, document = await saved_document(client, app, seed, monkeypatch, source_md)
        args = {
            "analysis_id": document["id"],
            "base_revision_id": document["revision_id"],
            "body": body,
        }
        scripted_turn(
            monkeypatch,
            [("", [call("update_analysis_preamble", args)], True), ("已完成。", [], True)],
        )
        job = await accept(client, await refreshed(client, seed), question="审核总述")
        await runtime.execute_job(app, job["id"])
        waiting = (await client.get(f"/api/jobs/{job['id']}")).json()
        proposal = waiting["review_proposal"]
        assert waiting["status"] == "waiting_review"
        approved = await client.post(
            f"/api/jobs/{job['id']}/decision",
            json={"expected_version": waiting["version"], "decision": "approve"},
        )
        assert approved.status_code == 200
        await runtime.execute_job(app, job["id"])
        saved = (await client.get(f"/api/analyses/{document['id']}")).json()
        assert saved["sections"][0]["raw"] == proposal["after"] == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("instructions", ["", "保存后继续说明用法"])
async def test_approved_review_rechecks_an_expired_base_revision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, instructions: str
) -> None:
    async with chat_client(tmp_path / "expired-review.db") as (client, app):
        seed = await seed_chat(client)
        _, document = await saved_document(client, app, seed, monkeypatch)
        sid = document["sections"][1]["uid"]
        args = {
            "analysis_id": document["id"],
            "base_revision_id": document["revision_id"],
            "sid": sid,
            "title": "审核标题",
        }
        captured = scripted_turn(
            monkeypatch,
            [
                ("", [call("update_analysis_section", args)], True),
                ("版本已变化，未保存。", [], True),
            ],
        )
        job = await accept(client, await refreshed(client, seed), question="审核后修改")
        await runtime.execute_job(app, job["id"])
        waiting = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert waiting["status"] == "waiting_review"
        async with app.state.session_factory() as session:
            await begin_write(session)
            external = await analyses.apply_operation(
                session,
                segment_id=seed["segment"]["id"],
                analysis_id=document["id"],
                base_revision_id=document["revision_id"],
                operation_key="external-edit",
                operation=SectionOperation(kind="update_section", sid=sid, title="外部标题"),
            )
            await session.commit()
        approved = await client.post(
            f"/api/jobs/{job['id']}/decision",
            json={
                "expected_version": waiting["version"],
                "decision": "approve",
                "additional_instructions": instructions,
            },
        )
        assert approved.status_code == 200
        await runtime.execute_job(app, job["id"])
        completed = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert completed["status"] == "succeeded"
        assert completed["artifacts"] == []
        feedback = json.loads(captured[-1]["messages"][-1]["content"])
        assert "error" in feedback
        assert "additional_instructions" not in feedback
        current = (await client.get(f"/api/analyses/{document['id']}")).json()
        assert current["revision_id"] == external.revision_id


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("tool_name", "invalid"),
    [
        (
            "insert_analysis_sections",
            {"after_sid": "missing", "sections": [{"title": "有效", "body": "正文"}]},
        ),
        (
            "update_analysis_preamble",
            {"body": "总述\n## 非法二级标题"},
        ),
        (
            "insert_analysis_sections",
            {
                "sections": [{"title": "有效", "body": "正文\n## 额外二级标题"}],
            },
        ),
    ],
)
async def test_invalid_edit_never_enters_waiting_review(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    tool_name: str,
    invalid: dict[str, Any],
) -> None:
    async with chat_client(tmp_path / "invalid-review.db") as (client, app):
        seed = await seed_chat(client)
        _, document = await saved_document(client, app, seed, monkeypatch)
        args = {
            "analysis_id": document["id"],
            "base_revision_id": document["revision_id"],
            **invalid,
        }
        scripted_turn(
            monkeypatch,
            [("", [call(tool_name, args)], True), ("方案无效，未提交审核。", [], True)],
        )
        job = await accept(client, await refreshed(client, seed), question="编辑讲解")
        await runtime.execute_job(app, job["id"])
        result = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert result["status"] == "succeeded"
        assert result["review_proposal"] is None
        assert result["artifacts"] == []


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
async def test_saved_document_survives_parent_failure_and_next_turn_gets_identity(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with chat_client(tmp_path / "partial.db") as (client, app):
        seed = await seed_chat(client)
        captured = scripted_turn(
            monkeypatch,
            [
                ("", [call("save_analysis", {"source_md": DOCUMENT})], True),
                ("残缺主回复", [], False),
                ("还能继续讨论", [], True),
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
        assert not any("残缺主回复" in json.dumps(item, ensure_ascii=False) for item in history)
        assert not any(
            json.dumps(DOCUMENT_BODY_MARKER, ensure_ascii=False)[1:-1]
            in json.dumps(item, ensure_ascii=False)
            for item in history
        )
        await runtime.execute_job(app, second["id"])
        assert (await client.get(f"/api/jobs/{second['id']}")).json()["status"] == "succeeded"
        assert captured[2]["messages"] == history


@pytest.mark.asyncio
async def test_stop_fences_save_call_even_when_model_returns_late(
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
        assert messages and tools and tool_choice == "auto"
        started.set()
        while not release.is_set():
            try:
                await release.wait()
            except asyncio.CancelledError:
                pass
        return adapters.ToolTurn(
            text="",
            completed=True,
            calls=[call("save_analysis", {"source_md": DOCUMENT})],
            history_items=[],
            usage=None,
            raw_response="{}",
        )

    monkeypatch.setattr(adapters, "complete_with_tools", late)
    async with chat_client(tmp_path / "stop.db") as (client, app):
        seed = await seed_chat(client)
        job = await accept(client, seed, question="整理并保存总体讲解")
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
        _, detail = await saved_document(client, app, seed, monkeypatch)
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
        _, detail = await saved_document(client, app, seed, monkeypatch)
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
async def test_stop_after_save_retains_artifact_and_continuation_fact(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with chat_client(tmp_path / "saved-stop.db") as (client, app):
        seed = await seed_chat(client)
        captured = scripted_turn(
            monkeypatch,
            [
                ("", [call("save_analysis", {"source_md": DOCUMENT})], True),
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
            if len(captured) == 1:
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
async def test_save_native_call_is_idempotent_and_keeps_first_run_provenance(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "idempotent-save.db"
    async with chat_client(database) as (client, app):
        seed = await seed_chat(client)
        identity = "provider-long-call-" + "x" * 200
        request = call("save_analysis", {"source_md": DOCUMENT}, identity)
        captured = scripted_turn(
            monkeypatch,
            [
                ("", [request], True),
                ("", [request], True),
                ("已保存。", [], True),
            ],
        )
        job = await accept(client, seed, question="保存讲解")
        await runtime.execute_job(app, job["id"])
        result = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert result["status"] == "succeeded"
        assert len(result["artifacts"]) == 1
        first = json.loads(captured[1]["messages"][-1]["content"])
        repeated = json.loads(captured[2]["messages"][-1]["content"])
        assert first == repeated
        with sqlite3.connect(database) as connection:
            count = connection.execute("SELECT count(*) FROM analysis_revisions").fetchone()[0]
            revision_run = connection.execute("SELECT run_id FROM analysis_revisions").fetchone()[0]
        assert count == 1
        assert revision_run == result["runs"][0]["id"]


@pytest.mark.asyncio
async def test_save_rejects_credentials_without_persisting_them(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "save-secret.db"
    async with chat_client(database) as (client, app):
        seed = await seed_chat(client)
        captured = scripted_turn(
            monkeypatch,
            [
                (
                    "",
                    [call("save_analysis", {"source_md": "## 提示\nfictional-chat-secret"})],
                    True,
                ),
                ("内容含凭据，未保存。", [], True),
            ],
        )
        job = await accept(client, seed, question="保存讲解")
        await runtime.execute_job(app, job["id"])
        result = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert result["artifacts"] == []
        assert json.loads(captured[1]["messages"][-1]["content"])["error"]
        with sqlite3.connect(database) as connection:
            assert connection.execute("SELECT count(*) FROM analyses").fetchone()[0] == 0
            durable = connection.execute("SELECT messages FROM runs").fetchall()
            durable += connection.execute("SELECT execution_state FROM chat_jobs").fetchall()
        assert "fictional-chat-secret" not in json.dumps(durable)


@pytest.mark.asyncio
@pytest.mark.parametrize("fence", ["token", "stop", "delete"])
async def test_save_write_transaction_checks_live_claim_and_parents(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fence: str
) -> None:
    from app.jobs import agent

    database = tmp_path / "save-gate.db"
    original = vars(agent)["_save_analysis"]
    async with chat_client(database) as (client, app):
        seed = await seed_chat(client)

        async def fenced_save(
            application: Any,
            job_id: str,
            token: str,
            call_id: str,
            args: dict[str, Any],
            key: str | None,
            messages: list[dict[str, Any]],
            tools: list[dict[str, Any]],
            protocol: str,
        ) -> dict[str, Any]:
            if fence == "stop":
                assert (await client.post(f"/api/jobs/{job_id}/stop")).status_code == 200
            elif fence == "delete":
                assert (
                    await client.delete(f"/api/segments/{seed['segment']['id']}")
                ).status_code == 204
            else:
                with sqlite3.connect(database) as connection:
                    connection.execute(
                        "UPDATE chat_jobs SET execution_token='new-token' WHERE id=?", (job_id,)
                    )
            output = await original(
                application, job_id, token, call_id, args, key, messages, tools, protocol
            )
            assert output == {"error": "job_stopped"}
            return output

        monkeypatch.setattr(agent, "_save_analysis", fenced_save)
        scripted_turn(monkeypatch, [("", [call("save_analysis", {"source_md": DOCUMENT})], True)])
        job = await accept(client, seed, question="保存")
        await runtime.execute_job(app, job["id"])
        with sqlite3.connect(database) as connection:
            assert connection.execute("SELECT count(*) FROM analyses").fetchone()[0] == 0


@pytest.mark.asyncio
async def test_legacy_tool_schema_does_not_restart_removed_generation_branch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "legacy-tool.db"
    async with chat_client(database) as (client, app):
        seed = await seed_chat(client)
        captured = scripted_turn(
            monkeypatch,
            [
                ("", [call("generate_analysis")], True),
                ("旧工具已停用。", [], True),
            ],
        )
        job = await accept(client, seed)
        with sqlite3.connect(database) as connection:
            raw = connection.execute(
                "SELECT input_snapshot FROM chat_jobs WHERE id=?", (job["id"],)
            ).fetchone()[0]
            snapshot = json.loads(raw)
            snapshot["tools"] = [
                {
                    "type": "function",
                    "function": {"name": "generate_analysis", "parameters": {"type": "object"}},
                }
            ]
            connection.execute(
                "UPDATE chat_jobs SET input_snapshot=? WHERE id=?",
                (json.dumps(snapshot), job["id"]),
            )
        await runtime.execute_job(app, job["id"])
        result = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert result["status"] == "succeeded"
        assert result["artifacts"] == []
        assert len(captured) == len(result["runs"]) == 2
        assert {run["purpose"] for run in result["runs"]} == {"chat"}
        output = json.loads(captured[1]["messages"][-1]["content"])
        assert output["error"] == "tool_not_supported"
        assert captured[0]["tools"] == captured[1]["tools"] == snapshot["tools"]


@pytest.mark.asyncio
async def test_legacy_unfinished_generation_is_interrupted_without_model_or_artifact_loss(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "legacy-job.db"
    async with chat_client(database) as (client, app):
        seed = await seed_chat(client)
        captured = scripted_turn(monkeypatch, [])
        job = await accept(client, seed)
        artifact = {"analysis_id": "retained-analysis", "revision_id": "retained-revision"}
        with sqlite3.connect(database) as connection:
            connection.execute(
                "UPDATE chat_jobs SET kind='generate_analysis', execution_state=? WHERE id=?",
                (json.dumps({"artifacts": [artifact]}), job["id"]),
            )
        before = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert before["kind"] == "generate_analysis"
        await runtime.execute_job(app, job["id"])
        result = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert result["status"] == "interrupted"
        assert result["artifacts"] == [artifact]
        assert result["runs"] == captured == []
        thread = (await client.get(f"/api/threads/{seed['thread']['id']}")).json()
        assert thread["active_job_id"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol", ["chat_completions", "responses"])
@pytest.mark.parametrize("overflow", ["fits", "result", "call"])
async def test_save_respects_actual_followup_context_budget_before_commit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, protocol: str, overflow: str
) -> None:
    from test_chat_prompt_scope import accepted_input

    from app.jobs import agent

    database = tmp_path / "save-budget.db"
    async with chat_client(database) as (client, app):
        seed = await seed_chat(client)
        if protocol == "responses":
            assert (
                await client.patch(
                    f"/api/providers/{seed['provider']['id']}", json={"protocol": protocol}
                )
            ).status_code == 200
        job = await accept(client, seed, question="保存预算边界讲解")
        frozen = accepted_input(database, job["id"])
        identity = "budget-call"
        title = "预算"
        marker = "独特边界正文MARK"

        def native_call(body: str) -> list[dict[str, Any]]:
            arguments = json.dumps({"source_md": body, "title": title}, ensure_ascii=False)
            if protocol == "chat_completions":
                return [
                    {
                        "role": "assistant",
                        "content": None,
                        "reasoning_content": "real-reasoning",
                        "tool_calls": [
                            {
                                "id": identity,
                                "type": "function",
                                "function": {"name": "save_analysis", "arguments": arguments},
                            }
                        ],
                    }
                ]
            return [
                {"type": "reasoning", "id": "r_1", "summary": []},
                {
                    "type": "function_call",
                    "call_id": identity,
                    "name": "save_analysis",
                    "arguments": arguments,
                },
            ]

        result = json.dumps(
            {"status": "saved", "title": title, "analysis_id": "0" * 26, "revision_id": "0" * 26},
            ensure_ascii=False,
        )
        result_item = (
            {"role": "tool", "tool_call_id": identity, "content": result}
            if protocol == "chat_completions"
            else {"type": "function_call_output", "call_id": identity, "output": result}
        )
        baseline = [*frozen["messages"], *native_call(marker)]
        if overflow != "call":
            baseline.append(result_item)
        size = len(json.dumps({"messages": baseline, "tools": frozen["tools"]}, ensure_ascii=False))
        padding = agent.MAX_CONTEXT_CHARS - size + (overflow != "fits")
        assert padding > 100000
        body = marker + "文" * padding
        captured = scripted_turn(
            monkeypatch,
            [
                ("", [call("save_analysis", {"source_md": body, "title": title}, identity)], True),
                ("已保存。", [], True),
            ],
        )
        await runtime.execute_job(app, job["id"])
        final = (await client.get(f"/api/jobs/{job['id']}")).json()
        if overflow == "fits":
            assert final["status"] == "succeeded"
            assert len(final["artifacts"]) == 1
            assert len(captured) == 2
            actual = len(
                json.dumps(
                    {"messages": captured[1]["messages"], "tools": captured[1]["tools"]},
                    ensure_ascii=False,
                )
            )
            assert actual == agent.MAX_CONTEXT_CHARS
            document = (
                await client.get(f"/api/analyses/{final['artifacts'][0]['analysis_id']}")
            ).json()
            assert document["source_md"] == body
        else:
            assert final["status"] == "failed"
            assert final["error_code"] == "context_limit"
            assert final["artifacts"] == []
            assert len(captured) == 1
            with sqlite3.connect(database) as connection:
                assert connection.execute("SELECT count(*) FROM analyses").fetchone()[0] == 0
                assert (
                    connection.execute("SELECT count(*) FROM analysis_revisions").fetchone()[0] == 0
                )
            next_job = await accept(client, await refreshed(client, seed), question="继续讨论")
            next_input = accepted_input(database, next_job["id"])
            assert marker not in json.dumps(next_input["messages"], ensure_ascii=False)
