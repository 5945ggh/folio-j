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
        "additional_instructions": "请简短解释。",
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
        assert job["additional_instructions"] == "请简短解释。"
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
