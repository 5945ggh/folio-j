"""C2-15: accepted jobs freeze actual saved context without executing a model."""

import json
import sqlite3
from pathlib import Path
from typing import Any, NoReturn
from uuid import uuid4

import pytest
from test_chat_api import accept, chat_client
from test_segment_provenance import compiled_provenance, provenance, setup_material


def snapshot_bytes(database: Path, job_id: str) -> bytes:
    with sqlite3.connect(database) as connection:
        row = connection.execute(
            "SELECT CAST(input_snapshot AS BLOB) FROM chat_jobs WHERE id=?", (job_id,)
        ).fetchone()
    assert row is not None and isinstance(row[0], bytes)
    return row[0]


def stored_origin(database: Path, segment_id: str) -> tuple[Any, ...]:
    with sqlite3.connect(database) as connection:
        row = connection.execute(
            "SELECT * FROM segment_material_provenance WHERE segment_id=?", (segment_id,)
        ).fetchone()
    assert row is not None
    return row


@pytest.mark.asyncio
async def test_saved_context_is_frozen_per_job_without_implicit_model_calls(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    model_calls = 0

    async def discover(_url: str, _key: str | None) -> list[str]:
        return ["offline-model"]

    async def forbidden_model(*_args: object, **_kwargs: object) -> NoReturn:
        nonlocal model_calls
        model_calls += 1
        raise AssertionError("Saving material context and accepting a job must not call a model")

    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    monkeypatch.setattr("app.llm.adapters.discover_models", discover)
    monkeypatch.setattr("app.llm.adapters.generate_text", forbidden_model)
    monkeypatch.setattr("app.llm.adapters.complete_with_tools", forbidden_model)
    database = tmp_path / "material-context.db"
    async with chat_client(database) as (client, _application):
        source_id, material = await setup_material(client)
        # Manually confirmed context may exceed automatic budgets and need not match the book.
        before = "手動で確定した前文𠮷。\n" * 30
        after = "原書外の説明も含む、利用者の後文😀。"
        saved = await client.post(
            f"/api/sources/{source_id}/segments",
            json={
                "request_id": str(uuid4()),
                "material_provenance": provenance(material),
                "context_before": before,
                "context_after": after,
            },
        )
        assert saved.status_code == 201, saved.text
        segment = saved.json()
        segment_url = f"/api/segments/{segment['id']}"
        origin_before = stored_origin(database, segment["id"])
        assert segment["context_before"] == before and segment["context_after"] == after
        assert segment["text"] == "が𠮷"
        assert segment["material_provenance"]["ranges"][0]["prefix"] == "前"
        assert segment["material_provenance"]["ranges"][1]["suffix"] == "後"
        with sqlite3.connect(database) as connection:
            for table in ("chat_threads", "chat_jobs", "chat_messages", "runs"):
                assert connection.execute(f"SELECT count(*) FROM {table}").fetchone() == (0,)

        provider = await client.post(
            "/api/providers",
            json={
                "name": "离线快照验收",
                "base_url": "http://localhost:9999/v1",
                "protocol": "chat_completions",
                "api_key": "fictional-context-secret",
            },
        )
        assert provider.status_code == 201, provider.text
        model = await client.post(
            f"/api/providers/{provider.json()['id']}/models", json={"model_id": "offline-model"}
        )
        assert model.status_code == 201, model.text

        first_thread = await client.post(
            segment_url + "/threads",
            json={"request_id": str(uuid4()), "model_id": model.json()["id"]},
        )
        assert first_thread.status_code == 201, first_thread.text
        first_job = await accept(
            client,
            {"segment": segment, "thread": first_thread.json()},
            question="保存した前後文を使って説明してください。",
        )
        assert first_job["status"] == "queued" and first_job["run_id"] is None
        frozen = snapshot_bytes(database, first_job["id"])
        first_input = json.loads(frozen)
        assert first_input["segment"]["context_before"] == before
        assert first_input["segment"]["context_after"] == after
        assert first_input["segment"]["text"] == segment["text"]
        first_prompt = "\n".join(message["content"] for message in first_input["messages"])
        assert before in first_prompt and after in first_prompt

        new_before, new_after = "後から変更した前文。", ""
        changed = await client.patch(
            segment_url, json={"context_before": new_before, "context_after": new_after}
        )
        assert changed.status_code == 200, changed.text
        current = changed.json()
        assert current["revision"] > segment["revision"]
        assert current["text"] == segment["text"]
        assert current["material_provenance"] == segment["material_provenance"]
        assert stored_origin(database, segment["id"]) == origin_before
        assert snapshot_bytes(database, first_job["id"]) == frozen

        next_thread = await client.post(
            segment_url + "/threads",
            json={"request_id": str(uuid4()), "model_id": model.json()["id"]},
        )
        assert next_thread.status_code == 201, next_thread.text
        next_job = await accept(
            client,
            {"segment": current, "thread": next_thread.json()},
            question="今の前後文で説明してください。",
        )
        assert next_job["status"] == "queued" and next_job["run_id"] is None
        next_input = json.loads(snapshot_bytes(database, next_job["id"]))
        assert next_input["segment"]["context_before"] == new_before
        assert next_input["segment"]["context_after"] == new_after
        assert next_input["segment"]["text"] == segment["text"]
        next_prompt = "\n".join(message["content"] for message in next_input["messages"])
        assert new_before in next_prompt and before not in next_prompt and after not in next_prompt
        assert next_input["history"] == []
        assert snapshot_bytes(database, first_job["id"]) == frozen
        assert stored_origin(database, segment["id"]) == origin_before
        assert (await client.get(segment_url)).json() == current
        assert model_calls == 0
        with sqlite3.connect(database) as connection:
            assert connection.execute("SELECT count(*) FROM chat_threads").fetchone() == (2,)
            assert connection.execute("SELECT count(*) FROM chat_jobs").fetchone() == (2,)
            assert connection.execute("SELECT count(*) FROM runs").fetchone() == (0,)
