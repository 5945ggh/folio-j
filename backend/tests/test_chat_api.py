"""Independent offline acceptance checks for durable segment conversations."""

import asyncio
import json
import sqlite3
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.db import Base, create_engine
from app.main import create_app


@pytest.fixture(autouse=True)
def offline_chat_discovery(monkeypatch: pytest.MonkeyPatch) -> None:
    async def discover(_url: str, _key: str | None) -> list[str]:
        return ["offline-model"]

    monkeypatch.setattr("app.llm.adapters.discover_models", discover)


@asynccontextmanager
async def chat_client(database: Path) -> AsyncGenerator[tuple[AsyncClient, FastAPI], None]:
    engine = create_engine(database)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
    finally:
        await engine.dispose()
    app = create_app(database_path=database)
    app.state.chat_worker_enabled = False
    app.state.verification_worker_enabled = False
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            yield client, app


async def seed_chat(client: AsyncClient) -> dict[str, Any]:
    source = await client.post(
        "/api/sources", json={"title": "原作", "description": "来源说明", "note": "私有管理备注"}
    )
    assert source.status_code == 201, source.text
    source_id = source.json()["id"]
    segment = await client.post(
        f"/api/sources/{source_id}/segments",
        json={"text": "昨日は雨だった。", "context_before": "朝のこと。", "note": "片段管理备注"},
    )
    assert segment.status_code == 201, segment.text
    provider = await client.post(
        "/api/providers",
        json={
            "name": "离线服务",
            "base_url": "http://localhost:9999/v1",
            "protocol": "chat_completions",
            "api_key": "fictional-chat-secret",
        },
    )
    assert provider.status_code == 201, provider.text
    model = await client.post(
        f"/api/providers/{provider.json()['id']}/models", json={"model_id": "offline-model"}
    )
    assert model.status_code == 201, model.text
    settings = (await client.get("/api/settings")).json()
    defaults = {**settings["defaults"], "chat_model_id": model.json()["id"]}
    assert (await client.put("/api/settings/defaults", json=defaults)).status_code == 200
    created = await client.post(
        f"/api/segments/{segment.json()['id']}/threads", json={"request_id": str(uuid4())}
    )
    assert created.status_code == 201, created.text
    return {
        "source": source.json(),
        "segment": segment.json(),
        "provider": provider.json(),
        "model": model.json(),
        "thread": created.json(),
        "settings": settings,
    }


def question_payload(seed: dict[str, Any], **changes: Any) -> dict[str, Any]:
    return {
        "request_id": str(uuid4()),
        "expected_thread_revision": seed["thread"]["revision"],
        "expected_segment_revision": seed["segment"]["revision"],
        "question": "だった是什么意思？",
        "stream": True,
        **changes,
    }


async def accept(client: AsyncClient, seed: dict[str, Any], **changes: Any) -> dict[str, Any]:
    response = await client.post(
        f"/api/threads/{seed['thread']['id']}/jobs", json=question_payload(seed, **changes)
    )
    assert response.status_code == 202, response.text
    return response.json()


@pytest.mark.asyncio
async def test_explanation_prompt_is_available_without_provider_configuration(
    tmp_path: Path,
) -> None:
    async with chat_client(tmp_path / "prompt-only.db") as (client, _app):
        response = await client.get("/api/chat/explanation-prompt")
        assert response.status_code == 200, response.text
        assert set(response.json()) == {"question"}
        assert "创建并保存一份独立讲解" in response.json()["question"]
        assert "保存成功后" in response.json()["question"]
        assert "无须在对话中重复全文" in response.json()["question"]


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["chat", "generate_analysis"])
async def test_new_job_rejects_removed_action_selector(tmp_path: Path, action: str) -> None:
    async with chat_client(tmp_path / "removed-action.db") as (client, _app):
        seed = await seed_chat(client)
        response = await client.post(
            f"/api/threads/{seed['thread']['id']}/jobs", json=question_payload(seed, action=action)
        )
        assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_waiting_review_keeps_provider_and_model_busy(tmp_path: Path) -> None:
    database = tmp_path / "review.db"
    async with chat_client(database) as (client, app):
        seed = await seed_chat(client)
        job = await accept(client, seed)
        from sqlalchemy import text

        async with app.state.session_factory() as session:
            await session.execute(text("BEGIN IMMEDIATE"))
            await session.execute(
                text("UPDATE chat_jobs SET status='waiting_review' WHERE id=:job_id"),
                {"job_id": job["id"]},
            )
            await session.commit()
        model_delete = await client.delete(f"/api/provider-models/{seed['model']['id']}")
        provider_delete = await client.delete(f"/api/providers/{seed['provider']['id']}")
        assert model_delete.status_code == provider_delete.status_code == 409


@pytest.mark.asyncio
async def test_review_decision_is_idempotent_and_version_bound(tmp_path: Path) -> None:
    database = tmp_path / "decision.db"
    async with chat_client(database) as (client, app):
        seed = await seed_chat(client)
        job = await accept(client, seed)
        from sqlalchemy import text

        proposal = {
            "tool_call_id": "call_1",
            "source_run_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "tool_name": "update_analysis_section",
            "analysis_id": "01ARZ3NDEKTSV4RRFFQ69G5FAX",
            "base_revision_id": "01ARZ3NDEKTSV4RRFFQ69G5FAY",
            "title": "示例",
            "before": "## 原文\n",
            "after": "## 修改\n",
            "operation": {
                "kind": "update_section",
                "sid": "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
                "title": "修改",
            },
        }
        async with app.state.session_factory() as session:
            await session.execute(text("BEGIN IMMEDIATE"))
            await session.execute(
                text(
                    "UPDATE chat_jobs SET status='waiting_review', "
                    "execution_state=:state WHERE id=:job_id"
                ),
                {
                    "job_id": job["id"],
                    "state": json.dumps({"artifacts": [], "review_proposal": proposal}),
                },
            )
            await session.commit()
        url = f"/api/jobs/{job['id']}/decision"
        body = {"expected_version": job["version"], "decision": "approve"}
        first = await client.post(url, json=body)
        assert first.status_code == 200, first.text
        assert first.json()["status"] == "queued"
        repeat = await client.post(url, json=body)
        assert repeat.status_code == 200
        assert repeat.json()["version"] == first.json()["version"]
        conflict = await client.post(url, json={**body, "decision": "reject"})
        assert conflict.status_code == 409


@pytest.mark.asyncio
async def test_chat_accept_freezes_save_tools_and_current_model(tmp_path: Path) -> None:
    database = tmp_path / "quick.db"
    async with chat_client(database) as (client, _app):
        seed = await seed_chat(client)
        job = await accept(
            client,
            seed,
            question="请为当前片段生成总体讲解。",
        )
        assert job["kind"] == "chat"
        assert job["model"]["provider_model_id"] == seed["model"]["id"]
        with sqlite3.connect(database) as connection:
            row = connection.execute(
                "SELECT input_snapshot FROM chat_jobs WHERE id=?", (job["id"],)
            ).fetchone()
        assert row is not None
        snapshot = json.loads(row[0])
        assert [tool["function"]["name"] for tool in snapshot["tools"]] == [
            "list_analyses",
            "read_analysis",
            "save_analysis",
            "update_analysis_section",
            "insert_analysis_sections",
            "delete_analysis_section",
            "update_analysis_preamble",
        ]
        update_tool = next(
            tool
            for tool in snapshot["tools"]
            if tool["function"]["name"] == "update_analysis_section"
        )
        assert update_tool["function"]["parameters"]["required"] == [
            "analysis_id",
            "base_revision_id",
            "sid",
        ]


@pytest.mark.asyncio
async def test_accept_atomically_locks_text_and_records_snapshot_without_run(
    tmp_path: Path,
) -> None:
    database = tmp_path / "chat.db"
    async with chat_client(database) as (client, _app):
        seed = await seed_chat(client)
        assert seed["segment"]["text_locked_at"] is None
        job = await accept(client, seed)
        assert job["status"] == "queued"
        assert job["run_id"] is None
        assert job["assistant_message"]["status"] == "pending"
        segment_url = f"/api/segments/{seed['segment']['id']}"
        current = (await client.get(segment_url)).json()
        assert current["text_locked_at"] is not None
        assert current["revision"] == seed["segment"]["revision"]
        assert (await client.patch(segment_url, json={"text": "新しい原文"})).status_code == 409
        assert (await client.patch(segment_url, json={"note": "別の管理メモ"})).status_code == 200
        messages = (await client.get(f"/api/threads/{seed['thread']['id']}/messages")).json()
        assert [item["role"] for item in messages["items"]] == ["user", "assistant"]
        assert messages["items"][0]["content"] == "だった是什么意思？"
        assert job["question"] == "だった是什么意思？"
        assert "additional_instructions" not in job
        assert "fictional-chat-secret" not in json.dumps(job)
        assert "credential_ref" not in job
        assert "base_url" not in job["model"]
    with sqlite3.connect(database) as connection:
        row = connection.execute("SELECT input_snapshot FROM chat_jobs").fetchone()
        snapshot = json.loads(row[0])
        assert snapshot["segment"]["text"] == "昨日は雨だった。"
        assert snapshot["source"]["updated_at"].endswith("+00:00")
        assert snapshot["style"]["updated_at"].endswith("+00:00")
        assert snapshot["history"] == []
        assert "私有管理备注" not in json.dumps(snapshot, ensure_ascii=False)
        assert "片段管理备注" not in json.dumps(snapshot, ensure_ascii=False)
        assert connection.execute("SELECT count(*) FROM runs").fetchone()[0] == 0


@pytest.mark.asyncio
async def test_accept_replay_and_competing_request_are_durable(tmp_path: Path) -> None:
    database = tmp_path / "chat.db"
    async with chat_client(database) as (client, _app):
        seed = await seed_chat(client)
        url = f"/api/threads/{seed['thread']['id']}/jobs"
        body = question_payload(seed)
        pair = await asyncio.gather(client.post(url, json=body), client.post(url, json=body))
        assert [response.status_code for response in pair] == [202, 202]
        assert pair[0].json()["id"] == pair[1].json()["id"]
        original_id = pair[0].json()["id"]
        conflict = await client.post(url, json={**body, "question": "不同问题"})
        assert conflict.status_code == 409
        assert conflict.json()["code"] == "idempotency_conflict"
        busy = await client.post(url, json={**body, "request_id": str(uuid4())})
        assert busy.status_code == 409
        assert busy.json()["code"] == "thread_busy"
        query = await client.get(f"{url}/by-request/{body['request_id']}")
        assert query.json()["id"] == original_id
    async with chat_client(database) as (client, _app):
        replay = await client.post(url, json=body)
        assert replay.status_code == 202
        assert replay.json()["id"] == original_id
        assert replay.json()["status"] == "interrupted"
        messages = (await client.get(f"/api/threads/{seed['thread']['id']}/messages")).json()
        assert len(messages["items"]) == 2
        assert messages["items"][1]["status"] == "interrupted"


@pytest.mark.asyncio
async def test_stale_or_unavailable_acceptance_has_no_partial_effects(tmp_path: Path) -> None:
    async with chat_client(tmp_path / "chat.db") as (client, _app):
        seed = await seed_chat(client)
        segment_url = f"/api/segments/{seed['segment']['id']}"
        edit = await client.patch(segment_url, json={"text": "今日は晴れだ。"})
        assert edit.status_code == 200
        url = f"/api/threads/{seed['thread']['id']}/jobs"
        stale = await client.post(url, json=question_payload(seed))
        assert stale.status_code == 409
        assert stale.json()["code"] == "stale_segment"
        assert (await client.get(segment_url)).json()["text_locked_at"] is None
        assert (await client.get(f"/api/threads/{seed['thread']['id']}")).json()[
            "active_job_id"
        ] is None
        assert (await client.get(f"/api/threads/{seed['thread']['id']}/messages")).json()[
            "items"
        ] == []
        disabled = await client.patch(
            f"/api/provider-models/{seed['model']['id']}", json={"enabled": False}
        )
        assert disabled.status_code == 200
        unavailable = await client.post(
            url, json=question_payload(seed, expected_segment_revision=edit.json()["revision"])
        )
        assert unavailable.status_code == 409
        assert unavailable.json()["code"] == "model_unavailable"
        assert (await client.get(segment_url)).json()["text_locked_at"] is None


@pytest.mark.asyncio
async def test_independent_threads_and_queued_stop_preserve_lock_and_defaults(
    tmp_path: Path,
) -> None:
    async with chat_client(tmp_path / "chat.db") as (client, _app):
        seed = await seed_chat(client)
        second = await client.post(
            f"/api/segments/{seed['segment']['id']}/threads", json={"request_id": str(uuid4())}
        )
        other_seed = {**seed, "thread": second.json()}
        first_job, second_job = await asyncio.gather(
            accept(client, seed), accept(client, other_seed)
        )
        stopped = await client.post(f"/api/jobs/{first_job['id']}/stop")
        assert stopped.status_code == 200, stopped.text
        assert stopped.json()["status"] == "interrupted"
        assert stopped.json()["error_code"] == "user_stopped"
        assert stopped.json()["run_id"] is None
        assert (await client.post(f"/api/jobs/{first_job['id']}/stop")).json() == stopped.json()
        assert (await client.get(f"/api/jobs/{second_job['id']}")).json()["status"] == "queued"
        current = (await client.get(f"/api/threads/{seed['thread']['id']}")).json()
        assert current["active_job_id"] is None
        assert (await client.get(f"/api/segments/{seed['segment']['id']}")).json()["text_locked_at"]
        busy_patch = await client.patch(
            f"/api/threads/{second.json()['id']}",
            json={"expected_revision": second.json()["revision"], "permission_mode": "full_access"},
        )
        assert busy_patch.status_code == 409
        changed = await client.patch(
            f"/api/threads/{current['id']}",
            json={"expected_revision": current["revision"], "permission_mode": "full_access"},
        )
        assert changed.status_code == 200
        assert changed.json()["permission_mode"] == "full_access"
        assert (await client.get("/api/settings")).json()["defaults"]["permission_mode"] == "review"


@pytest.mark.asyncio
async def test_thread_creation_replay_and_cursor_are_scoped(tmp_path: Path) -> None:
    async with chat_client(tmp_path / "chat.db") as (client, _app):
        seed = await seed_chat(client)
        url = f"/api/segments/{seed['segment']['id']}/threads"
        body = {"request_id": str(uuid4())}
        pair = await asyncio.gather(client.post(url, json=body), client.post(url, json=body))
        assert [item.status_code for item in pair] == [201, 201]
        assert pair[0].json()["id"] == pair[1].json()["id"]
        created_id = pair[0].json()["id"]
        first = await client.get(url, params={"limit": 1})
        page = first.json()
        assert page["next_cursor"] is not None
        later = await client.post(url, json={"request_id": str(uuid4())})
        second = await client.get(url, params={"limit": 1, "cursor": page["next_cursor"]})
        assert second.status_code == 200, second.text
        assert second.json()["items"][0]["id"] != page["items"][0]["id"]
        assert second.json()["items"][0]["id"] != later.json()["id"]
        assert second.json()["next_cursor"] is None
        conflict = await client.post(url, json={**body, "model_id": seed["model"]["id"]})
        assert conflict.status_code == 409
        assert (await client.get(url, params={"cursor": "bad"})).status_code == 422
        cleared = {**(await client.get("/api/settings")).json()["defaults"], "chat_model_id": None}
        assert (await client.put("/api/settings/defaults", json=cleared)).status_code == 200
        replay = await client.post(url, json=body)
        assert replay.status_code == 201
        assert replay.json()["id"] == created_id
        assert replay.json()["selected_model_id"] == seed["model"]["id"]


@pytest.mark.asyncio
@pytest.mark.parametrize("delete_source", [False, True])
async def test_cascade_delete_hides_jobs_messages_and_replays(
    tmp_path: Path, delete_source: bool
) -> None:
    async with chat_client(tmp_path / "chat.db") as (client, _app):
        seed = await seed_chat(client)
        job = await accept(client, seed)
        model_delete = await client.delete(f"/api/provider-models/{seed['model']['id']}")
        provider_delete = await client.delete(f"/api/providers/{seed['provider']['id']}")
        assert model_delete.status_code == provider_delete.status_code == 409
        target = (
            f"/api/sources/{seed['source']['id']}"
            if delete_source
            else f"/api/segments/{seed['segment']['id']}"
        )
        impact = await client.get(f"{target}/delete-impact")
        assert impact.status_code == 200, impact.text
        assert impact.json()["thread_count"] == 1
        assert impact.json()["message_count"] == 2
        assert impact.json()["active_job_count"] == 1
        assert (await client.delete(target)).status_code == 204
        for url in (
            f"/api/jobs/{job['id']}",
            f"/api/threads/{seed['thread']['id']}",
            f"/api/threads/{seed['thread']['id']}/messages",
            f"/api/threads/{seed['thread']['id']}/jobs/by-request/{job['request_id']}",
        ):
            assert (await client.get(url)).status_code == 404
        assert (await client.post(f"/api/jobs/{job['id']}/stop")).status_code == 404
        assert (
            await client.delete(f"/api/provider-models/{seed['model']['id']}")
        ).status_code == 204


@pytest.mark.asyncio
@pytest.mark.parametrize("in_segment", [False, True])
async def test_accept_rejects_current_credential_in_inputs_without_partial_writes(
    tmp_path: Path, in_segment: bool
) -> None:
    database = tmp_path / "chat.db"
    async with chat_client(database) as (client, _app):
        seed = await seed_chat(client)
        if in_segment:
            seed["segment"] = (
                await client.patch(
                    f"/api/segments/{seed['segment']['id']}",
                    json={"text": "fictional-chat-secret"},
                )
            ).json()
        body = question_payload(
            seed, question="解释原文" if in_segment else "误粘贴 fictional-chat-secret"
        )
        result = await client.post(f"/api/threads/{seed['thread']['id']}/jobs", json=body)
        assert result.status_code == 422, result.text
        assert result.json()["code"] == "credential_in_input"
        assert "fictional-chat-secret" not in result.text
        assert (await client.get(f"/api/threads/{seed['thread']['id']}/messages")).json()[
            "items"
        ] == []
        current = (await client.get(f"/api/segments/{seed['segment']['id']}")).json()
        assert current["text_locked_at"] is None
        assert current["text"] == seed["segment"]["text"]
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT count(*) FROM chat_jobs").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM runs").fetchone()[0] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("conversation_size", [1, 40])
async def test_history_page_projects_job_facts_without_loading_large_snapshots(
    tmp_path: Path, conversation_size: int
) -> None:
    from sqlalchemy import event

    database = tmp_path / "history-projection.db"
    async with chat_client(database) as (client, app):
        seed = await seed_chat(client)
        accepted = await accept(client, seed)
        with sqlite3.connect(database) as connection:
            connection.execute(
                "UPDATE chat_jobs SET status='failed', error='保留的失败原因', "
                "execution_state=?, input_snapshot=? WHERE id=?",
                (
                    json.dumps(
                        {
                            "artifacts": [
                                {"analysis_id": "saved-analysis", "revision_id": "old-revision"}
                            ],
                            "messages": ["large-private-state" * 10000],
                        }
                    ),
                    json.dumps(
                        {
                            "question": "原问题",
                            "additional_instructions": "补充要求",
                            "messages": ["large-private-input" * 10000],
                        }
                    ),
                    accepted["id"],
                ),
            )
            connection.execute(
                "UPDATE chat_messages SET status='failed' WHERE job_id=? AND role='assistant'",
                (accepted["id"],),
            )
            connection.execute(
                "UPDATE chat_threads SET active_job_id=NULL WHERE id=?", (seed["thread"]["id"],)
            )
        with sqlite3.connect(database) as connection:
            connection.row_factory = sqlite3.Row
            job_row = dict(connection.execute("SELECT * FROM chat_jobs").fetchone())
            message_rows = [
                dict(row)
                for row in connection.execute("SELECT * FROM chat_messages ORDER BY ordinal")
            ]
            for index in range(1, conversation_size):
                identity = f"history-job-{index}"
                job_row.update(id=identity, request_id=str(uuid4()))
                columns = ", ".join(job_row)
                placeholders = ", ".join("?" for _ in job_row)
                connection.execute(
                    f"INSERT INTO chat_jobs ({columns}) VALUES ({placeholders})",
                    tuple(job_row.values()),
                )
                for message in message_rows:
                    copy = {
                        **message,
                        "id": f"history-message-{index}-{message['role']}",
                        "job_id": identity,
                        "ordinal": index * 2 + message["ordinal"],
                    }
                    columns = ", ".join(copy)
                    placeholders = ", ".join("?" for _ in copy)
                    connection.execute(
                        f"INSERT INTO chat_messages ({columns}) VALUES ({placeholders})",
                        tuple(copy.values()),
                    )
        statements: list[str] = []
        async with app.state.session_factory() as session:
            engine = session.bind.sync_engine

        def capture(
            _connection: object,
            _cursor: object,
            statement: str,
            _parameters: object,
            _context: object,
            _many: bool,
        ) -> None:
            if statement.lstrip().upper().startswith("SELECT"):
                statements.append(statement)

        event.listen(engine, "before_cursor_execute", capture)
        try:
            response = await client.get(
                f"/api/threads/{seed['thread']['id']}/messages", params={"limit": 100}
            )
        finally:
            event.remove(engine, "before_cursor_execute", capture)
        assert response.status_code == 200, response.text
        messages = response.json()["items"]
        assert len(messages) == conversation_size * 2
        summary = messages[1]["job_summary"]
        assert summary == {
            "artifacts": [{"analysis_id": "saved-analysis", "revision_id": "old-revision"}],
            "error": "保留的失败原因",
            "retry": {"question": "原问题\n\n补充要求"},
        }
        assert messages[0]["job_summary"] is None
        assert len(statements) == 2, statements
        # JSON paths may be selected; complete Job / Run columns must not be transferred.
        projection = statements[-1].split("FROM")[0]
        assert "JSON_EXTRACT(chat_jobs.execution_state," in projection
        assert projection.count("chat_jobs.execution_state") == 1
        assert "JSON_EXTRACT(chat_jobs.input_snapshot," in projection
        assert projection.count("chat_jobs.input_snapshot") == 2
        assert "model_snapshot" not in projection and "request_payload" not in projection
        assert not any("FROM runs" in statement for statement in statements)
        assert "large-private" not in response.text
        statements.clear()
        event.listen(engine, "before_cursor_execute", capture)
        try:
            detail = await client.get(f"/api/jobs/{accepted['id']}")
        finally:
            event.remove(engine, "before_cursor_execute", capture)
        assert detail.status_code == 200, detail.text
        run_query = next(statement for statement in statements if "FROM runs" in statement)
        assert run_query.split("FROM")[0].strip() == "SELECT runs.id, runs.status, runs.purpose"


@pytest.mark.asyncio
async def test_backward_history_starts_at_latest_and_preserves_forward_cursor(
    tmp_path: Path,
) -> None:
    database = tmp_path / "history-pages.db"
    async with chat_client(database) as (client, _app):
        seed = await seed_chat(client)
        await accept(client, seed)
        endpoint = f"/api/threads/{seed['thread']['id']}/messages"
        latest = await client.get(endpoint, params={"direction": "backward", "limit": 1})
        assert latest.status_code == 200, latest.text
        assert [item["ordinal"] for item in latest.json()["items"]] == [2]
        assert latest.json()["next_cursor"] == 2
        older = await client.get(
            endpoint, params={"direction": "backward", "before_ordinal": 2, "limit": 1}
        )
        assert [item["ordinal"] for item in older.json()["items"]] == [1]
        assert older.json()["next_cursor"] is None
        forward = await client.get(endpoint, params={"after_ordinal": 1, "limit": 1})
        assert [item["ordinal"] for item in forward.json()["items"]] == [2]
        # New messages do not move an existing older-page boundary. A refresh
        # starts from the newest page and derives each subsequent boundary anew.
        with sqlite3.connect(database) as connection:
            connection.execute("UPDATE chat_jobs SET status='succeeded'")
            connection.execute("UPDATE chat_threads SET active_job_id=NULL")
        seed["thread"] = (await client.get(f"/api/threads/{seed['thread']['id']}")).json()
        await accept(client, seed)
        older_after_append = await client.get(
            endpoint, params={"direction": "backward", "before_ordinal": 2}
        )
        assert [item["ordinal"] for item in older_after_append.json()["items"]] == [1]
        refreshed = (
            await client.get(endpoint, params={"direction": "backward", "limit": 2})
        ).json()
        previous = (
            await client.get(
                endpoint,
                params={
                    "direction": "backward",
                    "before_ordinal": refreshed["next_cursor"],
                    "limit": 2,
                },
            )
        ).json()
        assert [item["ordinal"] for item in previous["items"] + refreshed["items"]] == [1, 2, 3, 4]
