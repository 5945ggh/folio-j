"""Offline manual Analysis writes preserve source text, revisions and operation identity."""

import asyncio
import hashlib
import json
import sqlite3
import unicodedata
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from race_helpers import paused_task
from sqlalchemy.ext.asyncio import AsyncSession
from test_chat_api import chat_client

from app.analysis_schemas import AnalysisDetail, SectionOperation
from app.ids import new_ulid
from app.services import analyses, sources


async def seed_segment(client: AsyncClient) -> tuple[str, dict[str, Any]]:
    source = (await client.post("/api/sources", json={"title": "手动资料"})).json()["id"]
    segment = (
        await client.post(f"/api/sources/{source}/segments", json={"text": "日本語を学ぶ。"})
    ).json()
    return source, segment


def create_payload(segment: dict[str, Any], source_md: str = "## 文法\n\n説明\n") -> dict[str, Any]:
    return {
        "request_id": str(uuid4()),
        "expected_text_sha256": segment["text_sha256"],
        "source_md": source_md,
    }


def revision_payload(
    segment: dict[str, Any], document: dict[str, Any], source_md: str
) -> dict[str, Any]:
    return {**create_payload(segment, source_md), "base_revision_id": document["revision_id"]}


def row_counts(database: Path) -> dict[str, int]:
    with sqlite3.connect(database) as connection:
        return {
            table: connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
            for table in ("analyses", "analysis_revisions", "chat_threads", "chat_jobs", "runs")
        }


@pytest.mark.asyncio
async def test_manual_and_imported_documents_save_without_models_and_keep_old_sections(
    tmp_path: Path,
) -> None:
    database = tmp_path / "manual.db"
    async with chat_client(database) as (client, _app):
        source, segment = await seed_segment(client)
        assert segment["text_locked_at"] is None
        assert segment["text_sha256"] == hashlib.sha256(segment["text"].encode()).hexdigest()
        assert (await client.get("/api/providers")).json() == []
        url = f"/api/segments/{segment['id']}/analyses"
        markdown = " \n総説\n\n## 文法\n説明e\u0301\n\n## 例\n日本語\n "
        created = await client.post(
            url, json={**create_payload(segment, markdown), "title": "  手書きe\u0301  "}
        )
        assert created.status_code == 200, created.text
        document = created.json()
        assert document["source_md"] == unicodedata.normalize("NFC", markdown)
        assert document["title"] == "手書きé"
        assert document["origin"] == "manual" and document["run_id"] is None
        locked = (await client.get(f"/api/segments/{segment['id']}")).json()
        assert locked["text_locked_at"] is not None
        assert locked["revision"] == segment["revision"]
        assert locked["text_sha256"] == segment["text_sha256"]
        assert (
            await client.patch(f"/api/segments/{segment['id']}", json={"text": "別の原文"})
        ).status_code == 409
        assert (
            await client.patch(f"/api/segments/{segment['id']}", json={"note": "管理备注"})
        ).status_code == 200
        replacement = "總説\n\n## 文法\n変更後\n"
        edited = await client.post(
            f"/api/analyses/{document['id']}/revisions",
            json=revision_payload(segment, document, replacement),
        )
        assert edited.status_code == 200, edited.text
        current = edited.json()
        assert current["origin"] == "manual_edit" and current["run_id"] is None
        assert current["parent_revision_id"] == document["revision_id"]
        assert current["title"] == document["title"]
        assert current["source_md"] == replacement
        assert {s["uid"] for s in current["sections"]}.isdisjoint(
            s["uid"] for s in document["sections"]
        )
        old = await client.get(
            f"/api/analyses/{document['id']}", params={"revision_id": document["revision_id"]}
        )
        assert old.json()["source_md"] == document["source_md"]
        assert old.json()["sections"] == document["sections"]
        assert (await client.get(f"/api/segments/{segment['id']}")).json()["text_locked_at"] == (
            locked["text_locked_at"]
        )
        imported = await client.post(
            url, json={**create_payload(segment, "沒有二級標題\n"), "origin": "import"}
        )
        assert imported.status_code == 200, imported.text
        assert imported.json()["origin"] == "import" and imported.json()["warnings"]
        assert [item["id"] for item in (await client.get(url)).json()]
        assert row_counts(database) == {
            "analyses": 2,
            "analysis_revisions": 3,
            "chat_threads": 0,
            "chat_jobs": 0,
            "runs": 0,
        }
    async with chat_client(database) as (client, _app):
        saved = await client.get(f"/api/analyses/{document['id']}")
        assert saved.status_code == 200 and saved.json()["source_md"] == replacement
        assert (await client.get(f"/api/sources/{source}/segments")).json()[0]["id"] == segment[
            "id"
        ]


@pytest.mark.asyncio
async def test_success_replay_survives_later_revisions_and_payload_changes_conflict(
    tmp_path: Path,
) -> None:
    database = tmp_path / "replay.db"
    async with chat_client(database) as (client, _app):
        _, segment = await seed_segment(client)
        create_url = f"/api/segments/{segment['id']}/analyses"
        body = create_payload(segment)
        pair = await asyncio.gather(
            client.post(create_url, json=body), client.post(create_url, json=body)
        )
        assert [r.status_code for r in pair] == [200, 200]
        original = pair[0].json()
        assert pair[1].json()["revision_id"] == original["revision_id"]
        revision_url = f"/api/analyses/{original['id']}/revisions"
        # The UUID may be reused across operation kinds; their namespaces differ.
        first_body = {
            **revision_payload(segment, original, "## 第一修改\n一\n"),
            "request_id": body["request_id"],
        }
        updates = await asyncio.gather(
            client.post(revision_url, json=first_body), client.post(revision_url, json=first_body)
        )
        assert [r.status_code for r in updates] == [200, 200]
        first = updates[0].json()
        assert updates[1].json()["revision_id"] == first["revision_id"]
        second = await client.post(
            revision_url, json=revision_payload(segment, first, "## 第二修改\n二\n")
        )
        assert second.status_code == 200, second.text
        replay = await client.post(create_url, json=body)
        assert replay.status_code == 200 and replay.json()["revision_id"] == original["revision_id"]
        replay = await client.post(revision_url, json=first_body)
        assert replay.status_code == 200 and replay.json()["revision_id"] == first["revision_id"]
        assert replay.json()["source_md"] == first_body["source_md"]
        for changes in (
            {"source_md": "## 不同正文\n変更\n"},
            {"expected_text_sha256": "0" * 64},
            {"origin": "import"},
            {"title": "不同标题"},
        ):
            conflict = await client.post(create_url, json={**body, **changes})
            assert conflict.status_code == 409 and conflict.json()["code"] == "idempotency_conflict"
        conflict = await client.post(
            revision_url, json={**first_body, "base_revision_id": second.json()["revision_id"]}
        )
        assert conflict.status_code == 409 and conflict.json()["code"] == "idempotency_conflict"
        assert row_counts(database)["analysis_revisions"] == 3
        with sqlite3.connect(database) as connection:
            payload = connection.execute(
                "SELECT operation_payload FROM analysis_revisions WHERE id=?",
                (original["revision_id"],),
            ).fetchone()[0]
        assert body["expected_text_sha256"] in payload


@pytest.mark.asyncio
async def test_no_changes_has_no_receipt_and_stale_or_foreign_base_is_rejected(
    tmp_path: Path,
) -> None:
    database = tmp_path / "versions.db"
    async with chat_client(database) as (client, _app):
        _, segment = await seed_segment(client)
        create_url = f"/api/segments/{segment['id']}/analyses"
        original = (
            await client.post(create_url, json=create_payload(segment, "## 文字\n説明é"))
        ).json()
        other = (await client.post(create_url, json=create_payload(segment))).json()
        url = f"/api/analyses/{original['id']}/revisions"
        body = revision_payload(segment, original, "## 文字\n説明e\u0301")
        unchanged = await client.post(url, json=body)
        assert unchanged.status_code == 422 and unchanged.json()["code"] == "no_changes"
        assert row_counts(database)["analysis_revisions"] == 2
        # The rejected operation did not reserve request_id.
        changed = await client.post(url, json={**body, "source_md": "## 次\n内容"})
        assert changed.status_code == 200, changed.text
        stale = await client.post(url, json=revision_payload(segment, original, "## 遅着\n内容"))
        assert stale.status_code == 409 and stale.json()["code"] == "stale_revision"
        foreign = await client.post(url, json=revision_payload(segment, other, "## 別文書\n内容"))
        assert foreign.status_code == 404 and foreign.json()["code"] == "not_found"
        bad_text = await client.post(
            url,
            json={
                **revision_payload(segment, changed.json(), "## 内容\n別"),
                "expected_text_sha256": "0" * 64,
            },
        )
        assert bad_text.status_code == 409 and bad_text.json()["code"] == "stale_text"
        assert row_counts(database)["analysis_revisions"] == 3


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "invalid",
    [
        {"source_md": " \n\t"},
        {"source_md": "a" * 500_001},
        {"request_id": "bad"},
        {"expected_text_sha256": "bad"},
        {"origin": "agent"},
        {"run_id": "pretend"},
        {"title": "a" * 201},
    ],
    ids=["blank", "oversized", "request", "digest", "origin", "run", "title"],
)
async def test_invalid_manual_input_has_no_partial_effects(
    tmp_path: Path, invalid: dict[str, Any]
) -> None:
    database = tmp_path / "invalid.db"
    async with chat_client(database) as (client, _app):
        _, segment = await seed_segment(client)
        response = await client.post(
            f"/api/segments/{segment['id']}/analyses",
            json={**create_payload(segment), **invalid},
        )
        assert response.status_code == 422
        assert isinstance(response.json()["detail"], list)
        assert (await client.get(f"/api/segments/{segment['id']}")).json()["text_locked_at"] is None
        assert row_counts(database)["analyses"] == 0


@pytest.mark.asyncio
async def test_note_edit_does_not_invalidate_original_text_digest(tmp_path: Path) -> None:
    async with chat_client(tmp_path / "notes.db") as (client, _app):
        _, segment = await seed_segment(client)
        updated = await client.patch(f"/api/segments/{segment['id']}", json={"note": "変更"})
        assert updated.json()["revision"] > segment["revision"]
        assert updated.json()["text_sha256"] == segment["text_sha256"]
        created = await client.post(
            f"/api/segments/{segment['id']}/analyses", json=create_payload(segment)
        )
        assert created.status_code == 200, created.text
        current = (await client.get(f"/api/segments/{segment['id']}")).json()
        assert current["revision"] == updated.json()["revision"]


@pytest.mark.asyncio
@pytest.mark.parametrize("winner", ["edit", "save"])
async def test_manual_save_and_original_text_edit_have_one_winner(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, winner: str
) -> None:
    database = tmp_path / "text-race.db"
    async with chat_client(database) as (client, _app):
        _, segment = await seed_segment(client)
        segment_url = f"/api/segments/{segment['id']}"
        create_url = segment_url + "/analyses"
        entered, release = asyncio.Event(), asyncio.Event()
        module = analyses if winner == "edit" else sources
        original = module.begin_write

        async def delayed(session: AsyncSession) -> None:
            entered.set()
            await release.wait()
            await original(session)

        monkeypatch.setattr(module, "begin_write", delayed)
        operation = (
            client.post(create_url, json=create_payload(segment))
            if winner == "edit"
            else client.patch(segment_url, json={"text": "別原文"})
        )
        async with asyncio.timeout(5), paused_task(operation, entered, release) as pending:
            winning = (
                await client.patch(segment_url, json={"text": "別原文"})
                if winner == "edit"
                else await client.post(create_url, json=create_payload(segment))
            )
            assert winning.status_code == 200, winning.text
        losing = pending.result()
        assert losing.status_code == 409
        current = (await client.get(segment_url)).json()
        if winner == "edit":
            assert losing.json()["code"] == "stale_text"
            assert current["text_locked_at"] is None
            assert row_counts(database)["analyses"] == 0
        else:
            assert current["text"] == segment["text"]
            assert current["text_locked_at"] is not None
            assert row_counts(database)["analyses"] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("winner", ["manual", "agent"])
async def test_manual_full_revision_and_agent_block_edit_cannot_overwrite_each_other(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, winner: str
) -> None:
    database = tmp_path / "revision-race.db"
    async with chat_client(database) as (client, app):
        _, segment = await seed_segment(client)
        document = (
            await client.post(
                f"/api/segments/{segment['id']}/analyses", json=create_payload(segment)
            )
        ).json()
        entered, release = asyncio.Event(), asyncio.Event()
        if winner == "agent":
            original = analyses.begin_write

            async def delayed(session: AsyncSession) -> None:
                entered.set()
                await release.wait()
                await original(session)

            monkeypatch.setattr(analyses, "begin_write", delayed)

        async def agent() -> str:
            if winner == "manual":
                entered.set()
                await release.wait()
            async with app.state.session_factory() as session:
                try:
                    await sources.begin_write(session)
                    await analyses.apply_operation(
                        session,
                        segment_id=segment["id"],
                        analysis_id=document["id"],
                        base_revision_id=document["revision_id"],
                        operation_key="job:test:edit:race",
                        operation=SectionOperation(
                            kind="update_section", sid=document["sections"][1]["uid"], title="Agent"
                        ),
                    )
                    await session.commit()
                    return "saved"
                except HTTPException as exc:
                    await session.rollback()
                    assert exc.status_code == 409
                    return "stale"

        url = f"/api/analyses/{document['id']}/revisions"
        body = revision_payload(segment, document, "## Manual\n新内容\n")
        if winner == "agent":
            async with (
                asyncio.timeout(5),
                paused_task(client.post(url, json=body), entered, release) as pending_manual,
            ):
                assert await agent() == "saved"
            manual = pending_manual.result()
            assert manual.status_code == 409 and manual.json()["code"] == "stale_revision"
        else:
            async with asyncio.timeout(5), paused_task(agent(), entered, release) as pending_agent:
                manual = await client.post(url, json=body)
                assert manual.status_code == 200, manual.text
            assert pending_agent.result() == "stale"
        assert row_counts(database)["analysis_revisions"] == 2
        current = (await client.get(f"/api/analyses/{document['id']}")).json()
        assert current["sections"][1]["title"] == ("Agent" if winner == "agent" else "Manual")


@pytest.mark.asyncio
async def test_two_manual_editors_only_one_current_base_can_commit(tmp_path: Path) -> None:
    async with chat_client(tmp_path / "two-editors.db") as (client, _app):
        _, segment = await seed_segment(client)
        document = (
            await client.post(
                f"/api/segments/{segment['id']}/analyses", json=create_payload(segment)
            )
        ).json()
        url = f"/api/analyses/{document['id']}/revisions"
        responses = await asyncio.gather(
            client.post(url, json=revision_payload(segment, document, "## A\n一")),
            client.post(url, json=revision_payload(segment, document, "## B\n二")),
        )
        assert sorted(r.status_code for r in responses) == [200, 409]
        assert next(r for r in responses if r.status_code == 409).json()["code"] == "stale_revision"


@pytest.mark.asyncio
@pytest.mark.parametrize("target", ["source", "segment", "analysis"])
async def test_deleted_targets_cannot_replay_or_recreate_successful_writes(
    tmp_path: Path, target: str
) -> None:
    database = tmp_path / "deleted.db"
    async with chat_client(database) as (client, _app):
        source, segment = await seed_segment(client)
        create_url = f"/api/segments/{segment['id']}/analyses"
        body = create_payload(segment)
        document = (await client.post(create_url, json=body)).json()
        revision_url = f"/api/analyses/{document['id']}/revisions"
        edit_body = revision_payload(segment, document, "## 変更\n内容")
        assert (await client.post(revision_url, json=edit_body)).status_code == 200
        delete_url = {
            "source": f"/api/sources/{source}",
            "segment": f"/api/segments/{segment['id']}",
            "analysis": f"/api/analyses/{document['id']}",
        }[target]
        assert (await client.delete(delete_url)).status_code == 204
        before = row_counts(database)
        for url, payload in ((create_url, body), (revision_url, edit_body)):
            response = await client.post(url, json=payload)
            assert response.status_code == 404 and response.json()["code"] == "not_found"
        assert row_counts(database) == before
        if target == "analysis":
            current = (await client.get(f"/api/segments/{segment['id']}")).json()
            assert current["text_locked_at"] is not None
            assert (
                await client.patch(f"/api/segments/{segment['id']}", json={"text": "別文"})
            ).status_code == 409


@pytest.mark.asyncio
@pytest.mark.parametrize("target", ["source", "segment"])
@pytest.mark.parametrize("winner", ["save", "delete"])
async def test_new_manual_save_and_ancestor_deletion_serialize_without_visible_late_content(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, target: str, winner: str
) -> None:
    database = tmp_path / "delete-race.db"
    async with chat_client(database) as (client, _app):
        source, segment = await seed_segment(client)
        create_url = f"/api/segments/{segment['id']}/analyses"
        delete_url = (
            f"/api/sources/{source}" if target == "source" else f"/api/segments/{segment['id']}"
        )
        body = create_payload(segment)
        entered, release = asyncio.Event(), asyncio.Event()
        module = sources if winner == "save" else analyses
        original = module.begin_write

        async def delayed(session: AsyncSession) -> None:
            entered.set()
            await release.wait()
            await original(session)

        monkeypatch.setattr(module, "begin_write", delayed)
        if winner == "save":
            async with (
                asyncio.timeout(5),
                paused_task(client.delete(delete_url), entered, release) as pending_delete,
            ):
                saved = await client.post(create_url, json=body)
                assert saved.status_code == 200, saved.text
            assert pending_delete.result().status_code == 204
            assert (await client.get(f"/api/analyses/{saved.json()['id']}")).status_code == 404
        else:
            async with (
                asyncio.timeout(5),
                paused_task(client.post(create_url, json=body), entered, release) as pending_save,
            ):
                assert (await client.delete(delete_url)).status_code == 204
            saved = pending_save.result()
            assert saved.status_code == 404 and saved.json()["code"] == "not_found"
        replay = await client.post(create_url, json=body)
        assert replay.status_code == 404 and replay.json()["code"] == "not_found"
        with sqlite3.connect(database) as connection:
            visible = connection.execute(
                "SELECT count(*) FROM analyses WHERE segment_id=? AND deleted_at IS NULL",
                (segment["id"],),
            ).fetchone()[0]
        assert visible == 0
        assert row_counts(database)["analyses"] == (1 if winner == "save" else 0)


@pytest.mark.asyncio
async def test_failed_storage_rolls_back_document_and_lock_then_same_request_can_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "rollback.db"
    original = analyses._save_revision  # pyright: ignore[reportPrivateUsage]

    async def fail(*args: Any, **kwargs: Any) -> AnalysisDetail:
        await original(*args, **kwargs)
        raise RuntimeError("simulated failure after flush")

    async with chat_client(database) as (client, _app):
        _, segment = await seed_segment(client)
        url = f"/api/segments/{segment['id']}/analyses"
        body = create_payload(segment)
        with monkeypatch.context() as failure:
            failure.setattr(analyses, "_save_revision", fail)
            with pytest.raises(RuntimeError, match="after flush"):
                await client.post(url, json=body)
        assert row_counts(database)["analyses"] == row_counts(database)["analysis_revisions"] == 0
        assert (await client.get(f"/api/segments/{segment['id']}")).json()["text_locked_at"] is None
        assert (await client.post(url, json=body)).status_code == 200


@pytest.mark.asyncio
async def test_pre_manual_ai_receipt_replays_without_new_payload_fields_but_not_after_deletion(
    tmp_path: Path,
) -> None:
    database = tmp_path / "legacy-receipt.db"
    async with chat_client(database) as (client, app):
        source, segment = await seed_segment(client)
        analysis_id, revision_id, section_id, uid = (new_ulid() for _ in range(4))
        operation_key = "job:pre-manual:create"
        markdown = "旧正文\n"
        stamp = "2026-09-30 12:00:00"
        # Fixed pre-A2 receipt shape: deliberately not produced by create_analysis.
        payload = {
            "segment_id": segment["id"],
            "origin": "agent",
            "run_id": None,
            "title": "旧讲解",
        }
        with sqlite3.connect(database) as connection:
            connection.execute(
                "UPDATE segments SET text_locked_at=? WHERE id=?", (stamp, segment["id"])
            )
            connection.execute(
                "INSERT INTO analyses "
                "(id,segment_id,operation_key,title,excerpt,"
                "current_revision_id,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (
                    analysis_id,
                    segment["id"],
                    operation_key,
                    "旧讲解",
                    "旧正文",
                    revision_id,
                    stamp,
                    stamp,
                ),
            )
            connection.execute(
                "INSERT INTO analysis_revisions "
                "(id,analysis_id,parent_revision_id,operation_key,operation_payload,origin,run_id,"
                "source_md,normalizer_version,warnings,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    revision_id,
                    analysis_id,
                    None,
                    operation_key,
                    json.dumps(payload),
                    "agent",
                    None,
                    markdown,
                    1,
                    "[]",
                    stamp,
                ),
            )
            connection.execute(
                "INSERT INTO analysis_sections "
                "(id,revision_id,uid,handle,kind,display_no,title,start_line,end_line,raw,ordinal) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (section_id, revision_id, uid, "s_old", "preamble", "P", None, 1, 1, markdown, 0),
            )

        async def replay() -> AnalysisDetail:
            async with app.state.session_factory() as session:
                try:
                    await sources.begin_write(session)
                    result = await analyses.create_analysis(
                        session,
                        segment_id=segment["id"],
                        source_md=markdown,
                        operation_key=operation_key,
                        origin="agent",
                        title="旧讲解",
                    )
                    await session.commit()
                    return result
                except BaseException:
                    await session.rollback()
                    raise

        result = await replay()
        assert result.id == analysis_id and result.revision_id == revision_id
        assert result.sections[0].uid == uid and result.source_md == markdown
        with sqlite3.connect(database) as connection:
            saved_payload = connection.execute(
                "SELECT operation_payload FROM analysis_revisions WHERE id=?", (revision_id,)
            ).fetchone()[0]
        assert json.loads(saved_payload) == payload
        assert row_counts(database)["analysis_revisions"] == 1
        assert (await client.delete(f"/api/sources/{source}")).status_code == 204
        with pytest.raises(HTTPException) as deleted:
            await replay()
        assert deleted.value.status_code == 404
