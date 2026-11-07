"""Optional book deletion uses exact origins and the existing learning deletion fences."""

import asyncio
import sqlite3
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from chat_tool_fixture import install_text_turn
from httpx import AsyncClient
from sqlalchemy.exc import IntegrityError
from support_api import accept, chat_client
from support_api import offline_chat_discovery as offline_chat_discovery
from test_chat_material_provenance import material_chat
from test_material_deletion import ASSET_TABLES, seed_assets
from test_segment_provenance import compiled_provenance, create_segment, provenance, span, upload
from test_source_deletion import table_snapshot

from app.ids import new_ulid
from app.jobs import runtime
from app.llm import adapters


@pytest.fixture(autouse=True)
def compile_offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)


async def manual_history(client: AsyncClient, segment: dict[str, Any]) -> dict[str, Any]:
    created = await client.post(
        f"/api/segments/{segment['id']}/analyses",
        json={
            "request_id": str(uuid4()),
            "expected_text_sha256": segment["text_sha256"],
            "source_md": "# 人工讲解\n\n## 文法\n\n保留历史。\n",
        },
    )
    assert created.status_code == 200, created.text
    original = created.json()
    revised = await client.post(
        f"/api/analyses/{original['id']}/revisions",
        json={
            "request_id": str(uuid4()),
            "expected_text_sha256": segment["text_sha256"],
            "base_revision_id": original["revision_id"],
            "source_md": "# 人工讲解\n\n## 文法\n\n第二版历史。\n",
        },
    )
    assert revised.status_code == 200, revised.text
    return original


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["queued", "running", "waiting_review", "stopping"])
async def test_selected_book_deletes_exact_learning_scope_and_retries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, status: str
) -> None:
    database = tmp_path / "exact.db"
    cancellations: list[str] = []

    def record_cancel(_app: Any, job: str) -> None:
        cancellations.append(job)

    monkeypatch.setattr("app.jobs.runtime.request_chat_cancel", record_cancel)
    async with chat_client(database) as (client, _app):
        seed = await material_chat(client)
        source_id = seed["source"]["id"]
        material = seed["material"]
        url = f"/api/materials/{material['id']}"
        target = seed["segment"]["id"]
        # Same book, different range; even identical text elsewhere cannot broaden the scope.
        extra = await create_segment(client, source_id, provenance(material, span("r1", 0, 0, 1)))
        assert extra.status_code == 201, extra.text
        other_upload = await client.post(
            f"/api/sources/{source_id}/materials",
            content=b"another book",
            headers={"content-type": "application/epub+zip"},
        )
        other_book = other_upload.json()["material"]
        other = await create_segment(client, source_id, provenance(other_book))
        assert other.status_code == 201, other.text
        other_source = (await client.post("/api/sources", json={"title": "其他来源"})).json()["id"]
        third_book = await upload(client, other_source)
        third = await create_segment(client, other_source, provenance(third_book))
        assert third.status_code == 201, third.text
        manual = (await client.get(f"/api/sources/{source_id}/segments")).json()
        manual_id = next(row["id"] for row in manual if row["material_provenance"] is None)
        # Matching free-text source_ref is never a precise provenance relation.
        assert (
            await client.patch(f"/api/segments/{manual_id}", json={"source_ref": material["title"]})
        ).status_code == 200
        analysis = await manual_history(client, seed["segment"])
        job = await accept(client, seed)
        seed_assets(database, material["id"])
        with sqlite3.connect(database) as connection:
            connection.execute(
                "UPDATE chat_jobs SET status=?,execution_token='old-token' WHERE id=?",
                (status, job["id"]),
            )
            # Deletion and impact use only immutable IDs, never decompress the book.
            connection.execute(
                "UPDATE materials SET compiled_bundle=X'0000' WHERE id=?", (material["id"],)
            )
        immutable = table_snapshot(
            database, ("analysis_revisions", "analysis_sections", "segment_material_provenance")
        )
        impact = await client.get(url + "/delete-impact", params={"delete_learning_content": True})
        assert impact.status_code == 200, impact.text
        assert impact.json() == {
            "material_id": material["id"],
            "hidden_result_count": 0,
            "retained_result_count": 0,
            "active_task_count": 0,
            "segment_count": 2,
            "analysis_count": 1,
            "thread_count": 1,
            "message_count": 2,
            "active_job_count": 1,
        }
        # Changes after preview belong to the actual commit, without another confirmation.
        with sqlite3.connect(database) as connection:
            connection.execute(
                "UPDATE materials SET compiled_bundle="
                "(SELECT compiled_bundle FROM materials WHERE id=?) WHERE id=?",
                (other_book["id"], material["id"]),
            )
        late = await create_segment(client, source_id, provenance(material, span("r1", 2, 0, 1)))
        assert late.status_code == 201, late.text
        immutable = table_snapshot(database, tuple(immutable))
        with sqlite3.connect(database) as connection:
            connection.execute(
                "UPDATE materials SET compiled_bundle=X'0000' WHERE id=?", (material["id"],)
            )
        expected_ids = sorted([target, extra.json()["id"], late.json()["id"]])
        for _ in range(2):
            deleted = await client.delete(url, params={"delete_learning_content": True})
            assert deleted.status_code == 200, deleted.text
            assert deleted.json() == {
                "material_id": material["id"],
                "deleted_segment_ids": expected_ids,
            }
        assert cancellations == [job["id"]]
        assert table_snapshot(database, tuple(immutable)) == immutable
        for endpoint in (
            f"segments/{target}",
            f"segments/{target}/analyses",
            f"analyses/{analysis['id']}",
            f"analyses/{analysis['id']}?revision_id={analysis['revision_id']}",
            f"threads/{seed['thread']['id']}",
            f"threads/{seed['thread']['id']}/messages",
            f"jobs/{job['id']}",
        ):
            assert (await client.get("/api/" + endpoint)).status_code == 404, endpoint
        assert (
            await client.post(
                f"/api/jobs/{job['id']}/decision",
                json={"expected_version": job["version"], "decision": "approve"},
            )
        ).status_code == 404
        for segment_id in (manual_id, other.json()["id"], third.json()["id"]):
            assert (await client.get(f"/api/segments/{segment_id}")).status_code == 200
        assert (await client.get(f"/api/sources/{source_id}")).status_code == 200
        assert (await client.get(url + "/delete-impact")).json()["segment_count"] == 0
        with sqlite3.connect(database) as connection:
            state = connection.execute(
                "SELECT status,execution_token,error_code,deleted_at FROM chat_jobs WHERE id=?",
                (job["id"],),
            ).fetchone()
            assert (
                state is not None
                and state[:3] == ("interrupted", None, "content_deleted")
                and state[3] is not None
            )
            assert connection.execute("SELECT count(*) FROM analysis_revisions").fetchone() == (2,)
            assert (
                connection.execute(
                    "SELECT deleted_at FROM analyses WHERE id=?", (analysis["id"],)
                ).fetchone()[0]
                is not None
            )
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


@pytest.mark.asyncio
async def test_default_delete_preserves_exact_learning_then_explicit_tombstone_cleanup(
    tmp_path: Path,
) -> None:
    database = tmp_path / "default.db"
    async with chat_client(database) as (client, _app):
        seed = await material_chat(client)
        analysis = await manual_history(client, seed["segment"])
        await accept(client, seed)
        tables = (
            "sources",
            "segments",
            "analyses",
            "analysis_revisions",
            "analysis_sections",
            "chat_threads",
            "chat_messages",
            "chat_jobs",
            "runs",
            "segment_material_provenance",
        )
        before = table_snapshot(database, tables)
        url = f"/api/materials/{seed['material']['id']}"
        assert (await client.get(url + "/delete-impact")).json()["segment_count"] == 1
        for _ in range(2):
            response = await client.delete(url)
            assert response.status_code == 204 and response.content == b""
        assert table_snapshot(database, tables) == before
        assert (await client.get(f"/api/analyses/{analysis['id']}")).status_code == 200
        assert (
            await client.get(url + "/delete-impact", params={"delete_learning_content": True})
        ).json()["analysis_count"] == 1
        response = await client.delete(url, params={"delete_learning_content": True})
        assert response.status_code == 200
        assert response.json()["deleted_segment_ids"] == [seed["segment"]["id"]]
        assert (await client.get(f"/api/segments/{seed['segment']['id']}")).status_code == 404
        assert (await client.get("/api/materials/missing/delete-impact")).status_code == 404
        assert (
            await client.delete("/api/materials/missing", params={"delete_learning_content": True})
        ).status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["assets", "learning"])
async def test_learning_deletion_failure_rolls_back_assets_jobs_and_learning(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    database = tmp_path / "rollback.db"
    cancellations: list[str] = []

    def record_cancel(_app: Any, job: str) -> None:
        cancellations.append(job)

    monkeypatch.setattr("app.jobs.runtime.request_chat_cancel", record_cancel)
    async with chat_client(database) as (client, _app):
        seed = await material_chat(client)
        await manual_history(client, seed["segment"])
        await accept(client, seed)
        seed_assets(database, seed["material"]["id"])
        from test_translations import request

        configured = await client.put(
            "/api/settings/translation",
            json={"expected_revision": 0, "model_id": seed["model"]["id"]},
        )
        assert configured.status_code == 200, configured.text
        queued_translation = await client.post(
            f"/api/materials/{seed['material']['id']}/translations",
            json=request(seed["source"]["id"], seed["material"]),
        )
        assert queued_translation.status_code == 200, queued_translation.text
        tables = (
            "sources",
            "segments",
            "materials",
            "analyses",
            "analysis_revisions",
            "analysis_sections",
            "chat_threads",
            "chat_messages",
            "chat_jobs",
            "runs",
            "translation_tasks",
            "translation_results",
            "translation_adoptions",
            *ASSET_TABLES,
        )
        before = table_snapshot(database, tables)
        with sqlite3.connect(database) as connection:
            event = (
                "BEFORE DELETE ON material_readings_generations"
                if failure == "assets"
                else "BEFORE UPDATE OF deleted_at ON analyses"
            )
            connection.execute(
                f"CREATE TRIGGER reject_cleanup {event} "
                "BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END"
            )
        url = f"/api/materials/{seed['material']['id']}"
        with pytest.raises(IntegrityError, match="injected cleanup failure"):
            await client.delete(url, params={"delete_learning_content": True})
        assert table_snapshot(database, tables) == before
        assert cancellations == []
        with sqlite3.connect(database) as connection:
            connection.execute("DROP TRIGGER reject_cleanup")
        assert (
            await client.delete(url, params={"delete_learning_content": True})
        ).status_code == 200
        assert len(cancellations) == 1
        with sqlite3.connect(database) as connection:
            assert connection.execute(
                "SELECT status FROM translation_tasks WHERE id=?",
                (queued_translation.json()["id"],),
            ).fetchone() == ("cancelled",)


@pytest.mark.asyncio
async def test_book_learning_deletion_fences_late_chat_output(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started, release = asyncio.Event(), asyncio.Event()

    async def generate(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        await progress("删除前残文")
        started.set()
        while not release.is_set():
            try:
                await release.wait()
            except asyncio.CancelledError:
                pass
        await progress("迟到正文")
        return adapters.GenerateResult("迟到完整回答", True, None, "{}")

    install_text_turn(monkeypatch, generate)
    database = tmp_path / "late.db"
    async with chat_client(database) as (client, app):
        seed = await material_chat(client)
        job = await accept(client, seed)
        task = asyncio.create_task(runtime.execute_job(app, job["id"]))
        try:
            await asyncio.wait_for(started.wait(), timeout=3)
            deleted = await client.delete(
                f"/api/materials/{seed['material']['id']}", params={"delete_learning_content": True}
            )
            assert deleted.status_code == 200, deleted.text
            before = table_snapshot(
                database, ("segments", "chat_jobs", "chat_messages", "runs", "analyses")
            )
            release.set()
            await asyncio.wait_for(task, timeout=3)
            assert table_snapshot(database, tuple(before)) == before
            assert (await client.get(f"/api/jobs/{job['id']}")).status_code == 404
        finally:
            release.set()
            await asyncio.wait_for(task, timeout=3)


@pytest.mark.asyncio
@pytest.mark.parametrize("delete_learning_content", [False, True])
@pytest.mark.parametrize("reader_removed", [False, True])
async def test_impact_translation_adoptions_follow_selected_learning_scope(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    delete_learning_content: bool,
    reader_removed: bool,
) -> None:
    from test_translations import request, segment_request, setup

    from app.services import translations

    async def generate(*_args: Any) -> adapters.GenerateResult:
        return adapters.GenerateResult("離線翻訳", True, None, "{}")

    monkeypatch.setattr(translations, "generate_text", generate)
    database = tmp_path / "translation-impact.db"
    async with chat_client(database) as (client, app):
        source, material, _seed = await setup(client)
        url = f"/api/materials/{material['id']}"
        first = await client.post(url + "/translations", json=request(source, material))
        assert first.status_code == 200, first.text
        await translations.execute(app, first.json()["id"])
        first_task = (await client.get(f"/api/translation-tasks/{first.json()['id']}")).json()
        result_id = first_task["result_id"]
        saved = await client.post(
            f"/api/sources/{source}/segments", json=segment_request(material, result_id)
        )
        assert saved.status_code == 201, saved.text
        if reader_removed:
            first_result = (await client.get(f"/api/translation-results/{result_id}")).json()
            removed = await client.delete(url + "/translations/" + first_result["identity_sha256"])
            assert removed.status_code == 200, removed.text
        second = await client.post(url + "/translations", json=request(source, material))
        assert second.status_code == 200, second.text
        await translations.execute(app, second.json()["id"])
        second_task = (await client.get(f"/api/translation-tasks/{second.json()['id']}")).json()
        legacy = await client.post(f"/api/sources/{source}/segments", json={"text": "が𠮷"})
        assert legacy.status_code == 201, legacy.text
        # The retired adoption entry point could associate results with a manual Segment.
        # Keep that valid historical read path without broadening the current write API.
        with sqlite3.connect(database) as connection:
            connection.execute(
                "INSERT INTO translation_adoptions "
                "(id,request_id,request_payload,adopted_payload,result_id,segment_id,created_at) "
                "SELECT ?,?,request_payload,adopted_payload,?,?,created_at "
                "FROM translation_adoptions LIMIT 1",
                (new_ulid(), str(uuid4()), second_task["result_id"], legacy.json()["id"]),
            )
        queued = await client.post(url + "/translations", json=request(source, material))
        assert queued.status_code == 200, queued.text
        impact = await client.get(
            url + "/delete-impact", params={"delete_learning_content": delete_learning_content}
        )
        assert impact.status_code == 200, impact.text
        assert impact.json() == {
            "material_id": material["id"],
            "hidden_result_count": 1 if delete_learning_content else 0,
            "retained_result_count": 1 if delete_learning_content else 2,
            "active_task_count": 1,
            "segment_count": 1,
            "analysis_count": 0,
            "thread_count": 0,
            "message_count": 0,
            "active_job_count": 0,
        }
        result = await client.delete(
            url, params={"delete_learning_content": delete_learning_content}
        )
        assert result.status_code == (200 if delete_learning_content else 204), result.text
        assert (await client.get(f"/api/translation-results/{result_id}")).status_code == (
            404 if delete_learning_content else 200
        )
        legacy_results = await client.get(
            f"/api/segments/{legacy.json()['id']}/translation-results"
        )
        assert legacy_results.status_code == 200, legacy_results.text
        assert [row["id"] for row in legacy_results.json()] == [second_task["result_id"]]
        assert legacy_results.json()[0]["material_deleted"] is True
        with sqlite3.connect(database) as connection:
            assert connection.execute(
                "SELECT status,token FROM translation_tasks WHERE id=?", (queued.json()["id"],)
            ).fetchone() == ("cancelled", None)
            assert connection.execute("SELECT count(*) FROM translation_adoptions").fetchone() == (
                2,
            )
            assert connection.execute("SELECT count(*) FROM translation_results").fetchone() == (2,)
