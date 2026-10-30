"""Reader removal preserves learning content while fencing old translation work."""

import asyncio
import sqlite3
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import event
from test_chat_api import chat_client
from test_chat_api import offline_chat_discovery as offline_chat_discovery
from test_manual_analyses import create_payload
from test_segment_provenance import compiled_provenance, provenance, span
from test_translations import request, setup

from app.llm.adapters import GenerateResult
from app.provenance_schemas import MaterialProvenance
from app.services import material_provenance, translations
from app.translation_models import TranslationTask


def removal_path(material: dict[str, Any], body: dict[str, Any]) -> str:
    identity = translations.identity_sha256(
        MaterialProvenance.model_validate(body["material_provenance"])
    )
    return f"/api/materials/{material['id']}/translations/{identity}"


def counts(database: Path) -> dict[str, int]:
    with sqlite3.connect(database) as connection:
        return {
            table: connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
            for table in (
                "translation_tasks",
                "translation_results",
                "translation_adoptions",
                "runs",
                "segments",
                "analyses",
            )
        }


@pytest.mark.asyncio
async def test_removal_hides_all_versions_only_at_exact_target_and_allows_explicit_new_request(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)

    async def fake(*_args: Any) -> GenerateResult:
        return GenerateResult("译文", True, None, None)

    monkeypatch.setattr(translations, "generate_text", fake)
    database = tmp_path / "all-versions.db"
    async with chat_client(database) as (client, app):
        source, material, _ = await setup(client)
        path = f"/api/materials/{material['id']}/translations"
        first = request(source, material) | {
            "text": "前",
            "material_provenance": provenance(material, span("r1", 0, 0, 1)),
        }
        second = first | {"request_id": str(uuid4())}
        other = first | {
            "request_id": str(uuid4()),
            "material_provenance": provenance(material, span("r1", 2, 0, 1)),
        }
        tasks: list[dict[str, Any]] = []
        for body in (first, second, other):
            accepted = await client.post(path, json=body)
            assert accepted.status_code == 200, accepted.text
            await translations.execute(app, accepted.json()["id"])
            task = (await client.get(f"/api/translation-tasks/{accepted.json()['id']}")).json()
            assert task["status"] == "succeeded", task
            tasks.append(task)
        before = counts(database)
        removed = await client.delete(removal_path(material, first))
        assert removed.status_code == 200, removed.text
        result = removed.json()
        assert result["task_ids"] == [task["id"] for task in tasks[:2]]
        assert result["result_ids"] == [task["result_id"] for task in tasks[:2]]
        assert result["cancelled_task_ids"] == []
        assert (await client.delete(removal_path(material, first))).json() == result
        assert counts(database) == before
        history = (await client.get(path)).json()
        assert [task["id"] for task in history["tasks"]] == [tasks[2]["id"]]
        chapter = (
            await client.get(
                f"/api/materials/{material['id']}/chapters/c1/translations",
                params={"version_id": material["version_id"]},
            )
        ).json()
        assert [item["result_id"] for item in chapter["items"]] == [tasks[2]["result_id"]]
        assert chapter["unavailable_count"] == 0
        impact = (await client.get(f"/api/materials/{material['id']}/delete-impact")).json()
        assert impact["hidden_result_count"] == 1
        assert impact["retained_result_count"] == 0
        for task in tasks[:2]:
            for endpoint in (
                f"translation-tasks/{task['id']}",
                f"translation-results/{task['result_id']}",
                f"runs/{task['run_id']}",
            ):
                assert (await client.get(f"/api/{endpoint}")).status_code == 404
        assert (await client.post(path, json=first)).status_code == 404
        assert (
            await client.get(f"/api/translation-results/{tasks[2]['result_id']}")
        ).status_code == 200
        replacement = await client.post(path, json=first | {"request_id": str(uuid4())})
        assert replacement.status_code == 200, replacement.text
        await translations.execute(app, replacement.json()["id"])
        fresh = (await client.get(path)).json()
        assert len(fresh["results"]) == 2
        assert not any(item["reader_deleted"] for item in fresh["results"])
        assert (
            await client.delete(f"/api/materials/{material['id']}/translations/invalid")
        ).status_code == 422


@pytest.mark.asyncio
async def test_removed_adopted_snapshot_and_run_survive_but_new_adoptions_are_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)

    async def fake(*_args: Any) -> GenerateResult:
        return GenerateResult("原译文", True, None, None)

    monkeypatch.setattr(translations, "generate_text", fake)
    database = tmp_path / "retained.db"
    async with chat_client(database) as (client, app):
        source, material, _ = await setup(client)
        body = request(source, material)
        task = (
            await client.post(f"/api/materials/{material['id']}/translations", json=body)
        ).json()
        await translations.execute(app, task["id"])
        done = (await client.get(f"/api/translation-tasks/{task['id']}")).json()
        result_id = done["result_id"]
        save = {
            "request_id": str(uuid4()),
            "material_provenance": provenance(material),
            "translation_result_id": result_id,
            "translation": "用户改写",
            "context_before": "片段前文",
        }
        segment_path = f"/api/sources/{source}/segments"
        saved = await client.post(segment_path, json=save)
        assert saved.status_code == 201, saved.text
        segment = saved.json()
        analysis_saved = await client.post(
            f"/api/segments/{segment['id']}/analyses", json=create_payload(segment)
        )
        assert analysis_saved.status_code == 200, analysis_saved.text
        analysis = analysis_saved.json()
        adopt_path = f"/api/translation-results/{result_id}/adopt"
        link = {"request_id": str(uuid4()), "segment_id": segment["id"]}
        receipt = await client.post(adopt_path, json=link)
        assert receipt.status_code == 200, receipt.text
        before = counts(database)
        removed = await client.delete(removal_path(material, body))
        assert removed.status_code == 200, removed.text
        assert counts(database) == before
        assert (await client.get(f"/api/segments/{segment['id']}")).json() == segment
        assert (await client.get(f"/api/analyses/{analysis['id']}")).json() == analysis
        statements: list[str] = []

        def capture(
            _connection: Any,
            _cursor: Any,
            statement: str,
            _parameters: Any,
            _context: Any,
            _many: Any,
        ) -> None:
            statements.append(statement)

        engine = app.state.session_factory.kw["bind"].sync_engine
        event.listen(engine, "before_cursor_execute", capture)
        try:
            retained = await client.get(f"/api/segments/{segment['id']}/translation-results")
            assert retained.status_code == 200, retained.text
            assert len(retained.json()) == 1
            assert retained.json()[0]["reader_deleted"] is True
            assert retained.json()[0]["translation"] == "原译文"
            for endpoint in (
                f"translation-results/{result_id}",
                f"translation-tasks/{task['id']}",
                f"runs/{done['run_id']}",
                f"materials/{material['id']}/translations",
            ):
                assert (await client.get(f"/api/{endpoint}")).status_code == 200
        finally:
            event.remove(engine, "before_cursor_execute", capture)
        assert statements and not any(
            "materials.compiled_bundle" in statement for statement in statements
        )
        assert (await client.post(segment_path, json=save)).json()["id"] == segment["id"]
        assert (await client.post(adopt_path, json=link)).json() == receipt.json()
        assert (
            await client.post(segment_path, json=save | {"request_id": str(uuid4())})
        ).status_code == 404
        assert (await client.post(adopt_path, json={"request_id": str(uuid4())})).status_code == 404
        assert (
            await client.post(adopt_path, json=link | {"request_id": str(uuid4())})
        ).status_code == 404
        assert (
            await client.post(f"/api/materials/{material['id']}/translations", json=body)
        ).status_code == 404
        assert counts(database) == before
        assert (await client.delete(f"/api/sources/{source}")).status_code == 204
        for endpoint in (
            f"translation-results/{result_id}",
            f"translation-tasks/{task['id']}",
            f"runs/{done['run_id']}",
        ):
            assert (await client.get(f"/api/{endpoint}")).status_code == 404


@pytest.mark.asyncio
async def test_removal_revokes_running_and_queued_tasks_before_late_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    entered, release = asyncio.Event(), asyncio.Event()
    calls = 0

    async def fake(*_args: Any) -> GenerateResult:
        nonlocal calls
        calls += 1
        entered.set()
        await release.wait()
        return GenerateResult("迟到输出", True, {"total_tokens": 12}, "迟到原响应")

    monkeypatch.setattr(translations, "generate_text", fake)
    async with chat_client(tmp_path / "late.db") as (client, app):
        source, material, seed = await setup(client)
        body = request(source, material)
        path = f"/api/materials/{material['id']}/translations"
        first = (await client.post(path, json=body)).json()
        queued = (await client.post(path, json=body | {"request_id": str(uuid4())})).json()
        execution = asyncio.create_task(translations.execute(app, first["id"]))
        await asyncio.wait_for(entered.wait(), 2)
        running = (await client.get(f"/api/translation-tasks/{first['id']}")).json()
        try:
            removed = await client.delete(removal_path(material, body))
            assert removed.status_code == 200, removed.text
            assert removed.json()["cancelled_task_ids"] == [first["id"], queued["id"]]
            assert (await client.delete(removal_path(material, body))).json() == removed.json()
        finally:
            release.set()
            await execution
        await translations.execute(app, queued["id"])
        assert calls == 1
        async with app.state.session_factory() as session:
            for accepted in (first, queued):
                stored = await session.get(TranslationTask, accepted["id"])
                assert stored is not None and stored.reader_deleted_at is not None
                assert (
                    stored.status == "cancelled"
                    and stored.token is None
                    and stored.result_id is None
                )
        with sqlite3.connect(tmp_path / "late.db") as connection:
            output = connection.execute(
                "SELECT status,output_text,usage,raw_response FROM runs WHERE id=?",
                (running["run_id"],),
            ).fetchone()
            assert output == ("cancelled", "", None, None)
        assert (await client.get(path)).json() == {"results": [], "tasks": [], "next_offset": None}
        assert (
            await client.delete(f"/api/provider-models/{seed['model']['id']}")
        ).status_code == 204


@pytest.mark.asyncio
@pytest.mark.parametrize("entry", ["selection", "adopt"])
async def test_removal_during_new_adoption_validation_rejects_stale_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, entry: str
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)

    async def fake(*_args: Any) -> GenerateResult:
        return GenerateResult("保存译文", True, None, None)

    monkeypatch.setattr(translations, "generate_text", fake)
    database = tmp_path / "adoption-race.db"
    async with chat_client(database) as (client, app):
        source, material, _ = await setup(client)
        body = request(source, material)
        task = (
            await client.post(f"/api/materials/{material['id']}/translations", json=body)
        ).json()
        await translations.execute(app, task["id"])
        done = (await client.get(f"/api/translation-tasks/{task['id']}")).json()
        result_id = done["result_id"]
        existing = await client.post(
            f"/api/translation-results/{result_id}/adopt", json={"request_id": str(uuid4())}
        )
        assert existing.status_code == 200, existing.text
        before = counts(database)
        entered, release = asyncio.Event(), asyncio.Event()
        module = material_provenance if entry == "selection" else translations
        original = module.prepare_reference
        calls = 0

        async def delayed(*args: Any, **kwargs: Any) -> material_provenance.PreparedReference:
            nonlocal calls
            prepared = await original(*args, **kwargs)
            calls += 1
            if calls == (2 if entry == "selection" else 1):
                entered.set()
                await release.wait()
            return prepared

        monkeypatch.setattr(module, "prepare_reference", delayed)
        path = (
            f"/api/sources/{source}/segments"
            if entry == "selection"
            else f"/api/translation-results/{result_id}/adopt"
        )
        payload: dict[str, Any] = {"request_id": str(uuid4())}
        if entry == "selection":
            payload |= {
                "material_provenance": provenance(material),
                "translation_result_id": result_id,
            }
        pending = asyncio.create_task(client.post(path, json=payload))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            removed = await client.delete(removal_path(material, body))
            assert removed.status_code == 200, removed.text
        finally:
            release.set()
        rejected = await pending
        assert rejected.status_code == 404, rejected.text
        assert counts(database) == before
