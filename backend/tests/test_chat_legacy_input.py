"""Ordinary questions absorb legacy supplements without rewriting frozen history."""

import json
import sqlite3
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest
from chat_tool_fixture import install_text_turn
from support_api import accept, chat_client, question_payload, seed_chat
from test_analysis_agent import refreshed
from test_chat_prompt_scope import accepted_input

from app.jobs import runtime
from app.llm import adapters


@pytest.mark.asyncio
@pytest.mark.parametrize("additional", ["", "旧字段"])
async def test_new_ordinary_request_rejects_removed_supplement_field(
    tmp_path: Path, additional: str
) -> None:
    async with chat_client(tmp_path / "new.db") as (client, _app):
        seed = await seed_chat(client)
        response = await client.post(
            f"/api/threads/{seed['thread']['id']}/jobs",
            json=question_payload(seed, additional_instructions=additional),
        )
        assert response.status_code == 422, response.text
        job = await accept(client, seed, question="原问题\n\n请简短解释。")
        assert job["question"] == "原问题\n\n请简短解释。"
        assert "additional_instructions" not in job


@pytest.mark.asyncio
@pytest.mark.parametrize("length,status", [(20002, 202), (20003, 422)])
async def test_unified_question_limit_matches_largest_legacy_merged_input(
    tmp_path: Path, length: int, status: int
) -> None:
    database = tmp_path / "limit.db"
    async with chat_client(database) as (client, _app):
        seed = await seed_chat(client)
        question = "问" * length
        response = await client.post(
            f"/api/threads/{seed['thread']['id']}/jobs",
            json=question_payload(seed, question=question),
        )
        assert response.status_code == status, response.text
        if status == 202:
            assert response.json()["question"] == question
            frozen = accepted_input(database, response.json()["id"])
            assert frozen["question"] == question


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "question,additional",
    [("原问题", ""), ("原问题", "  保留空白\n第二行  "), ("旧" * 10000, "補" * 10000)],
    ids=["empty", "whitespace", "legacy-maximum"],
)
async def test_legacy_request_payload_replays_after_projection_without_rewriting_storage(
    tmp_path: Path, question: str, additional: str
) -> None:
    database = tmp_path / "replay.db"
    async with chat_client(database) as (client, _app):
        seed = await seed_chat(client)
        payload = question_payload(seed, question=question)
        endpoint = f"/api/threads/{seed['thread']['id']}/jobs"
        first = await client.post(endpoint, json=payload)
        assert first.status_code == 202, first.text
        identity = first.json()["id"]
        with sqlite3.connect(database) as connection:
            row = connection.execute(
                "SELECT request_payload, input_snapshot FROM chat_jobs WHERE id=?", (identity,)
            ).fetchone()
            assert row is not None
            legacy_payload = {**json.loads(row[0]), "additional_instructions": additional}
            legacy_snapshot = {**json.loads(row[1]), "additional_instructions": additional}
            connection.execute(
                "UPDATE chat_jobs SET request_payload=?, input_snapshot=? WHERE id=?",
                (json.dumps(legacy_payload), json.dumps(legacy_snapshot), identity),
            )
        merged = question + ("\n\n" + additional if additional else "")
        replay = await client.post(endpoint, json={**payload, "question": merged})
        assert replay.status_code == 202, replay.text
        assert replay.json()["id"] == identity
        assert replay.json()["question"] == merged
        assert "additional_instructions" not in replay.json()
        detail = await client.get(f"/api/jobs/{identity}")
        assert detail.json()["question"] == merged
        with sqlite3.connect(database) as connection:
            row = connection.execute(
                "SELECT request_payload, input_snapshot FROM chat_jobs WHERE id=?", (identity,)
            ).fetchone()
        assert row is not None
        assert json.loads(row[0]) == legacy_payload
        assert json.loads(row[1]) == legacy_snapshot


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "question,additional",
    [("旧问题", "  旧补充\n下一行  "), ("旧" * 10000, "補" * 10000)],
    ids=["whitespace", "legacy-maximum"],
)
async def test_legacy_failed_retry_keeps_supplement_in_new_question(
    tmp_path: Path, question: str, additional: str
) -> None:
    database = tmp_path / "retry.db"
    async with chat_client(database) as (client, _app):
        seed = await seed_chat(client)
        job = await accept(client, seed)
        snapshot = accepted_input(database, job["id"])
        old = {**snapshot, "question": question, "additional_instructions": additional}
        with sqlite3.connect(database) as connection:
            connection.execute(
                "UPDATE chat_jobs SET status='failed', input_snapshot=? WHERE id=?",
                (json.dumps(old), job["id"]),
            )
            connection.execute(
                "UPDATE chat_messages SET status='failed' WHERE job_id=? AND role='assistant'",
                (job["id"],),
            )
            connection.execute("UPDATE chat_threads SET active_job_id=NULL")
        messages = await client.get(f"/api/threads/{seed['thread']['id']}/messages")
        retry = messages.json()["items"][-1]["job_summary"]["retry"]
        assert retry == {"question": question + "\n\n" + additional}
        retried = await accept(client, await refreshed(client, seed), **retry)
        frozen = accepted_input(database, retried["id"])
        assert frozen["question"] == retry["question"]
        assert retry["question"].rstrip() in frozen["messages"][-1]["content"]
        assert "additional_instructions" not in frozen
        assert accepted_input(database, job["id"]) == old


@pytest.mark.asyncio
async def test_legacy_pending_job_executes_frozen_supplement_messages(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: list[list[dict[str, Any]] | None] = []

    async def generate(
        snapshot: adapters.CallSnapshot,
        _key: str | None,
        _progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        captured.append(snapshot.messages)
        return adapters.GenerateResult("旧任务正常回答。", True, None, "{}")

    install_text_turn(monkeypatch, generate)
    database = tmp_path / "pending.db"
    async with chat_client(database) as (client, app):
        seed = await seed_chat(client)
        job = await accept(client, seed)
        snapshot = accepted_input(database, job["id"])
        messages = [
            {"role": "system", "content": "旧固定规则"},
            {"role": "user", "content": "旧问题\n本轮补充要求：旧补充"},
        ]
        old = {**snapshot, "additional_instructions": "旧补充", "messages": messages}
        with sqlite3.connect(database) as connection:
            connection.execute(
                "UPDATE chat_jobs SET input_snapshot=? WHERE id=?", (json.dumps(old), job["id"])
            )
        await runtime.execute_job(app, job["id"])
        assert captured == [messages]
        assert accepted_input(database, job["id"]) == old
        detail = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert detail["status"] == "succeeded"
        with sqlite3.connect(database) as connection:
            row = connection.execute(
                "SELECT messages FROM runs WHERE job_id=?", (job["id"],)
            ).fetchone()
        assert row is not None
        assert json.loads(row[0]) == messages
