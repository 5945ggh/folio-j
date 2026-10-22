"""Strict, durable EPUB provenance never guesses a new target for saved text."""

import asyncio
import hashlib
import json
import sqlite3
import threading
import zlib
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from httpx import AsyncClient, Response
from sqlalchemy.exc import IntegrityError
from test_source_segment import api_client

from app.epub_schemas import ChapterPart, CompiledBook, CompiledChapter, CompiledResource
from app.provenance_schemas import MaterialProvenance, ProvenancePart
from app.services import material_provenance as provenance_service

TEXTS = {"r1": "前か", "r2": "\u3099𠮷後", "r3": "別章"}


def compiled_provenance(_data: bytes) -> CompiledBook:
    resources = [
        CompiledResource(
            id=resource_id,
            href=f"{resource_id}.xhtml",
            title=resource_id,
            text=text,
            html=f"<p>{text}</p>",
            css="",
            html_attributes={},
            body_attributes={},
            text_sha256=hashlib.sha256(text.encode()).hexdigest(),
        )
        for resource_id, text in TEXTS.items()
    ]

    def part(resource_id: str, spine_index: int) -> ChapterPart:
        return ChapterPart(
            resource_id=resource_id,
            spine_index=spine_index,
            start=0,
            end=len(TEXTS[resource_id]),
            html=f"<p>{TEXTS[resource_id]}</p>",
            leaf_start=0,
            leaf_end=1,
        )

    return CompiledBook(
        contract="test-v1",
        title="引用検証",
        warnings=[],
        product_sha256="a" * 64,
        resources=[resources[0], resources[1], resources[0], resources[2]],
        chapters=[
            CompiledChapter(
                id="c1",
                title="同じ章",
                level=0,
                parts=[part("r1", 0), part("r2", 1), part("r1", 2)],
            ),
            CompiledChapter(id="c2", title="別章", level=0, parts=[part("r3", 3)]),
        ],
    )


async def setup_material(client: AsyncClient) -> tuple[str, dict[str, Any]]:
    source_response = await client.post("/api/sources", json={"title": "出典"})
    assert source_response.status_code == 201, source_response.text
    source_id: str = source_response.json()["id"]
    return source_id, await upload(client, source_id)


async def upload(client: AsyncClient, source_id: str) -> dict[str, Any]:
    result = await client.post(
        f"/api/sources/{source_id}/materials",
        content=b"immutable EPUB",
        headers={"content-type": "application/epub+zip"},
    )
    assert result.status_code == 200, result.text
    return result.json()["material"]


def span(resource_id: str, spine_index: int, start: int, end: int) -> dict[str, Any]:
    text = TEXTS[resource_id]
    return {
        "resource_id": resource_id,
        "spine_index": spine_index,
        "start": start,
        "end": end,
        "exact": text[start:end],
        "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
    }


def provenance(material: dict[str, Any], *ranges: dict[str, Any]) -> dict[str, Any]:
    return {
        "contract_version": "1",
        "material_id": material["id"],
        "version_id": material["version_id"],
        "ranges": list(ranges) or [span("r1", 0, 1, 2), span("r2", 1, 0, 2)],
    }


async def create_segment(
    client: AsyncClient,
    source_id: str,
    reference: dict[str, Any],
    **fields: Any,
) -> Response:
    return await client.post(
        f"/api/sources/{source_id}/segments",
        json={"request_id": str(uuid4()), "material_provenance": reference, **fields},
    )


def row_counts(database: Path) -> tuple[int, int]:
    with sqlite3.connect(database) as connection:
        return (
            connection.execute("SELECT count(*) FROM segments").fetchone()[0],
            connection.execute("SELECT count(*) FROM segment_material_provenance").fetchone()[0],
        )


@pytest.mark.asyncio
async def test_create_canonical_match_lock_and_restart(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    database = tmp_path / "durable.db"
    async with api_client(database) as client:
        source_id, material = await setup_material(client)
        with sqlite3.connect(database) as connection:
            connection.execute("DELETE FROM material_readings_current")
            connection.execute("DELETE FROM material_readings_generations")
            connection.commit()
        reference = provenance(material)
        result = await create_segment(client, source_id, reference, context_before="編集した前文")
        assert result.status_code == 201, result.text
        saved = result.json()
        assert saved["text"] == "が𠮷"
        assert saved["text_locked_at"] is not None
        assert saved["material_provenance"]["version_id"] == material["version_id"]
        assert saved["context_before"] == "編集した前文" and saved["context_after"] == ""
        assert saved["text_sha256"] == hashlib.sha256("が𠮷".encode()).hexdigest()
        url = f"/api/segments/{saved['id']}"
        resolved = await client.get(url + "/material-provenance")
        assert resolved.status_code == 200, resolved.text
        assert resolved.json()["status"] == "resolved"
        assert resolved.json()["display"] == "引用検証 · 同じ章 · 章内约 16%"
        assert resolved.json()["chapter_id"] == "c1"
        assert resolved.json()["assembly_rule"] == "concat-nfc-v1"
        assert [
            (part["spine_index"], part["start"], part["end"]) for part in resolved.json()["parts"]
        ] == [(0, 1, 2), (1, 0, 2)]
        # Matching uses canonical coordinates, with untrusted display context ignored.
        split = provenance(material, span("r1", 0, 1, 2), span("r2", 1, 0, 1), span("r2", 1, 1, 2))
        for entry in split["ranges"]:
            entry.update(prefix="別の前文", suffix="別の後文")
        matches = await client.post(
            f"/api/sources/{source_id}/segments/material-provenance/matches", json=split
        )
        assert matches.status_code == 200, matches.text
        assert [item["id"] for item in matches.json()["segments"]] == [saved["id"]]
        assert matches.json()["truncated"] is False
        selected = await client.post(url + "/material-provenance/select", json=split)
        assert selected.status_code == 200, selected.text
        assert selected.json()["context_before"] == "編集した前文"
        assert (await client.patch(url, json={"text": "別の原文"})).status_code == 409
        assert (await client.patch(url, json={"material_provenance": None})).status_code == 422
        changed = await client.patch(url, json={"context_before": "", "note": "自由に編集"})
        assert changed.status_code == 200, changed.text
        assert changed.json()["text"] == "が𠮷" and changed.json()["context_before"] == ""
        split_saved = await create_segment(client, source_id, split)
        assert split_saved.status_code == 201, split_saved.text
        assert len(split_saved.json()["material_provenance"]["ranges"]) == 2
        assert split_saved.json()["material_provenance"]["ranges"][0]["prefix"] == "前"
        assert split_saved.json()["material_provenance"]["ranges"][1]["suffix"] == "後"
        assert split_saved.json()["id"] != saved["id"]
        manual = await client.post(f"/api/sources/{source_id}/segments", json={"text": "が𠮷"})
        assert manual.status_code == 201, manual.text
        assert manual.json()["material_provenance"] is None
        assert manual.json()["text_locked_at"] is None
    async with api_client(database) as client:
        reread = await client.get(url)
        assert reread.status_code == 200, reread.text
        assert reread.json()["text"] == "が𠮷"
        assert reread.json()["context_before"] == "" and reread.json()["note"] == "自由に編集"
        assert (await client.get(url + "/material-provenance")).json()["status"] == "resolved"


@pytest.mark.asyncio
async def test_repeated_resource_occurrences_have_distinct_identity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    async with api_client(tmp_path / "spine.db") as client:
        source_id, material = await setup_material(client)
        first_ref = provenance(material, span("r1", 0, 0, 2))
        later_ref = provenance(material, span("r1", 2, 0, 2))
        first = await create_segment(client, source_id, first_ref)
        later = await create_segment(client, source_id, later_ref)
        assert first.status_code == later.status_code == 201
        assert first.json()["text"] == later.json()["text"] == "前か"
        assert first.json()["id"] != later.json()["id"]
        matches = await client.post(
            f"/api/sources/{source_id}/segments/material-provenance/matches", json=later_ref
        )
        assert [item["id"] for item in matches.json()["segments"]] == [later.json()["id"]]
        selected = await client.post(
            f"/api/segments/{first.json()['id']}/material-provenance/select", json=later_ref
        )
        assert selected.status_code == 409, selected.text
        continuous = await create_segment(
            client,
            source_id,
            provenance(material, span("r1", 0, 1, 2), span("r2", 1, 0, 3), span("r1", 2, 0, 1)),
        )
        assert continuous.status_code == 201, continuous.text
        assert continuous.json()["text"] == "が𠮷後前"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    [
        "version",
        "resource",
        "spine",
        "hash",
        "exact",
        "empty",
        "out_of_bounds",
        "reverse",
        "overlap",
        "gap",
        "skip_resource",
        "cross_chapter",
        "range_limit",
        "contract",
        "missing_request",
        "invalid_request",
        "empty_span",
        "prefix_limit",
        "mismatched_text",
        "cross_source",
    ],
)
async def test_invalid_reference_never_creates_partial_records(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, case: str
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    database = tmp_path / "invalid.db"
    async with api_client(database) as client:
        source_id, material = await setup_material(client)
        reference = provenance(material)
        fields: dict[str, Any] = {}
        if case == "version":
            reference["version_id"] = "missing-version"
        elif case == "resource":
            reference["ranges"][0]["resource_id"] = "missing"
        elif case == "spine":
            reference["ranges"][0]["spine_index"] = 1
        elif case in {"hash", "exact"}:
            reference["ranges"][0]["text_sha256" if case == "hash" else "exact"] = "b" * 64
        elif case == "empty":
            reference["ranges"] = []
        elif case == "out_of_bounds":
            reference["ranges"][0]["end"] = 99
        elif case == "reverse":
            reference["ranges"].reverse()
        elif case == "overlap":
            reference["ranges"] = [span("r2", 1, 0, 2), span("r2", 1, 1, 3)]
        elif case == "gap":
            reference["ranges"] = [span("r2", 1, 0, 1), span("r2", 1, 2, 3)]
        elif case == "skip_resource":
            reference["ranges"] = [span("r1", 0, 1, 2), span("r1", 2, 0, 1)]
        elif case == "cross_chapter":
            reference["ranges"] = [span("r1", 2, 1, 2), span("r3", 3, 0, 1)]
        elif case == "range_limit":
            reference["ranges"] = [span("r1", 0, 0, 1)] * 65
        elif case == "contract":
            reference["contract_version"] = "unknown"
        elif case == "missing_request":
            fields["request_id"] = None
        elif case == "invalid_request":
            fields["request_id"] = "not-a-uuid"
        elif case == "empty_span":
            reference["ranges"] = [span("r1", 0, 1, 1)]
        elif case == "prefix_limit":
            reference["ranges"][0]["prefix"] = "前" * 65
        elif case == "mismatched_text":
            fields["text"] = "同じ位置ではない"
        elif case == "cross_source":
            source_id = (await client.post("/api/sources", json={"title": "他所"})).json()["id"]
        result = await create_segment(client, source_id, reference, **fields)
        assert result.status_code in {404, 409, 422}, (case, result.text)
        assert row_counts(database) == (0, 0)


@pytest.mark.asyncio
async def test_snapshot_limit_is_rejected_without_truncation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    large = "𠮷" * 100001
    book = compiled_provenance(b"")
    resource = book.resources[0].model_copy(
        update={"text": large, "text_sha256": hashlib.sha256(large.encode()).hexdigest()}
    )
    part = book.chapters[0].parts[0].model_copy(update={"end": len(large)})
    book = book.model_copy(
        update={
            "resources": [resource],
            "chapters": [book.chapters[0].model_copy(update={"parts": [part]})],
        }
    )

    def compile_large(_data: bytes) -> CompiledBook:
        return book

    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compile_large)
    database = tmp_path / "limit.db"
    async with api_client(database) as client:
        source_id, material = await setup_material(client)
        reference = provenance(
            material,
            {
                "resource_id": "r1",
                "spine_index": 0,
                "start": 0,
                "end": len(large),
                "exact": large,
                "text_sha256": resource.text_sha256,
            },
        )
        result = await create_segment(client, source_id, reference)
        assert result.status_code == 422, result.text
        assert row_counts(database) == (0, 0)


@pytest.mark.asyncio
async def test_idempotent_retry_conflict_and_parallel_requests(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    database = tmp_path / "retry.db"
    async with api_client(database) as client:
        source_id, material = await setup_material(client)
        payload = {
            "request_id": str(uuid4()),
            "material_provenance": provenance(material),
            "context_before": "最初",
        }
        url = f"/api/sources/{source_id}/segments"
        results = await asyncio.gather(*[client.post(url, json=payload) for _ in range(3)])
        assert all(result.status_code in {200, 201} for result in results), [
            result.text for result in results
        ]
        segment_id = results[0].json()["id"]
        assert {result.json()["id"] for result in results} == {segment_id}
        assert row_counts(database) == (1, 1)
        for changes in (
            {"context_before": "違う操作"},
            {"material_provenance": provenance(material, span("r1", 2, 1, 2))},
        ):
            conflict = await client.post(url, json={**payload, **changes})
            assert conflict.status_code == 409, conflict.text
        assert (
            await client.patch(f"/api/segments/{segment_id}", json={"context_before": "編集後"})
        ).status_code == 200
    async with api_client(database) as client:
        retried = await client.post(url, json=payload)
        assert retried.status_code in {200, 201}, retried.text
        assert retried.json()["id"] == segment_id and retried.json()["context_before"] == "編集後"
        assert row_counts(database) == (1, 1)


@pytest.mark.asyncio
async def test_deleted_material_history_is_retained_and_reimport_never_rebinds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    database = tmp_path / "history.db"
    async with api_client(database) as client:
        source_id, material = await setup_material(client)
        reference = provenance(material)
        payload = {"request_id": str(uuid4()), "material_provenance": reference}
        result = await client.post(f"/api/sources/{source_id}/segments", json=payload)
        assert result.status_code == 201, result.text
        saved = result.json()
        url = f"/api/segments/{saved['id']}"
        assert (await client.delete(f"/api/materials/{material['id']}")).status_code == 204
        historical = await client.get(url)
        assert historical.status_code == 200 and historical.json()["text"] == "が𠮷"
        assert historical.json()["material_provenance"] == saved["material_provenance"]
        resolution = await client.get(url + "/material-provenance")
        assert resolution.status_code == 200 and resolution.json()["status"] == "material_deleted"
        assert resolution.json()["parts"] == []
        assert resolution.json()["display"] == "引用検証"
        assert (
            await client.post(url + "/material-provenance/select", json=reference)
        ).status_code in {404, 409}
        retry = await client.post(f"/api/sources/{source_id}/segments", json=payload)
        assert retry.status_code in {200, 201}, retry.text
        assert retry.json()["id"] == saved["id"]
        fresh = await upload(client, source_id)
        assert fresh["id"] != material["id"] and fresh["version_id"] != material["version_id"]
        assert (await client.get(url + "/material-provenance")).json()[
            "status"
        ] == "material_deleted"
        matches = await client.post(
            f"/api/sources/{source_id}/segments/material-provenance/matches", json=provenance(fresh)
        )
        assert matches.status_code == 200 and matches.json()["segments"] == []
        assert (await client.delete(url)).status_code == 204
        assert (await client.get(url + "/material-provenance")).status_code == 404
        assert (
            await client.post(url + "/material-provenance/select", json=reference)
        ).status_code == 404
        assert (await client.delete(f"/api/sources/{source_id}")).status_code == 204
        assert (await client.get(url)).status_code == 404
        assert (
            await client.post(
                f"/api/sources/{source_id}/segments/material-provenance/matches",
                json=provenance(fresh),
            )
        ).status_code == 404
        assert row_counts(database) == (1, 1)


@pytest.mark.asyncio
@pytest.mark.parametrize("corruption", ["version", "snapshot", "bundle", "product"])
async def test_unavailable_material_returns_explicit_status_and_preserves_text(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, corruption: str
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    database = tmp_path / "unavailable.db"
    async with api_client(database) as client:
        source_id, material = await setup_material(client)
        created = await create_segment(client, source_id, provenance(material))
        assert created.status_code == 201, created.text
        saved = created.json()
    with sqlite3.connect(database) as connection:
        if corruption == "version":
            connection.execute(
                "UPDATE materials SET version_id='unavailable' WHERE id=?", (material["id"],)
            )
        elif corruption == "product":
            connection.execute(
                "UPDATE materials SET product_sha256=? WHERE id=?", ("b" * 64, material["id"])
            )
        else:
            book = compiled_provenance(b"")
            if corruption == "snapshot":
                changed = book.resources[0].model_copy(update={"text": "前き"})
                book = book.model_copy(update={"resources": [changed, *book.resources[1:]]})
            connection.execute(
                "UPDATE materials SET compiled_bundle=? WHERE id=?",
                (
                    b"broken"
                    if corruption == "bundle"
                    else zlib.compress(book.model_dump_json().encode()),
                    material["id"],
                ),
            )
        connection.commit()
    async with api_client(database) as client:
        url = f"/api/segments/{saved['id']}"
        reread = await client.get(url)
        assert reread.status_code == 200 and reread.json()["text"] == "が𠮷"
        resolved = await client.get(url + "/material-provenance")
        assert resolved.status_code == 200, resolved.text
        assert resolved.json()["status"] == (
            "version_unavailable" if corruption == "version" else "snapshot_mismatch"
        )
        assert resolved.json()["parts"] == []
        assert resolved.json()["display"] == "引用検証"
        assert reread.json()["material_provenance"] == saved["material_provenance"]


@pytest.mark.asyncio
async def test_failed_provenance_insert_rolls_back_segment_and_receipt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    database = tmp_path / "atomic.db"
    async with api_client(database) as client:
        source_id, material = await setup_material(client)
        payload = {"request_id": str(uuid4()), "material_provenance": provenance(material)}
        with sqlite3.connect(database) as connection:
            connection.execute(
                "CREATE TRIGGER reject_provenance BEFORE INSERT ON segment_material_provenance "
                "BEGIN SELECT RAISE(ABORT, 'simulated persistence failure'); END"
            )
        with pytest.raises(IntegrityError, match="simulated persistence failure"):
            await client.post(f"/api/sources/{source_id}/segments", json=payload)
        assert row_counts(database) == (0, 0)
        with sqlite3.connect(database) as connection:
            connection.execute("DROP TRIGGER reject_provenance")
        retry = await client.post(f"/api/sources/{source_id}/segments", json=payload)
        assert retry.status_code == 201, retry.text
        assert row_counts(database) == (1, 1)


@pytest.mark.asyncio
@pytest.mark.parametrize("mutation", ["material_delete", "source_delete", "version", "bundle"])
async def test_validation_outside_write_lock_rechecks_deletion_and_identity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mutation: str
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    database = tmp_path / "race.db"
    async with api_client(database) as client:
        source_id, material = await setup_material(client)
        entered = threading.Event()
        release = threading.Event()
        original = provenance_service.validate_reference

        def delayed(
            book: CompiledBook, reference: MaterialProvenance
        ) -> tuple[MaterialProvenance, str, str, list[ProvenancePart]]:
            result = original(book, reference)
            entered.set()
            assert release.wait(5), "validation race was not released"
            return result

        monkeypatch.setattr(provenance_service, "validate_reference", delayed)
        task = asyncio.create_task(create_segment(client, source_id, provenance(material)))
        assert await asyncio.to_thread(entered.wait, 5), "validation did not start"
        try:
            if mutation == "material_delete":
                assert (await client.delete(f"/api/materials/{material['id']}")).status_code == 204
            elif mutation == "source_delete":
                assert (await client.delete(f"/api/sources/{source_id}")).status_code == 204
            else:
                with sqlite3.connect(database, timeout=2) as connection:
                    if mutation == "version":
                        connection.execute(
                            "UPDATE materials SET version_id='changed' WHERE id=?",
                            (material["id"],),
                        )
                    else:
                        connection.execute(
                            "UPDATE materials SET compiled_bundle=? WHERE id=?",
                            (b"changed immutable payload", material["id"]),
                        )
                    connection.commit()
        finally:
            release.set()
        result = await task
        assert result.status_code == (404 if mutation.endswith("delete") else 409), result.text
        assert row_counts(database) == (0, 0)


@pytest.mark.asyncio
async def test_bounded_matches_exclude_deleted_segments_and_ancestors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    async with api_client(tmp_path / "matches.db") as client:
        source_id, material = await setup_material(client)
        reference = provenance(material)
        created: list[dict[str, Any]] = []
        for _ in range(21):
            result = await create_segment(client, source_id, reference)
            assert result.status_code == 201, result.text
            created.append(result.json())
        matches_url = f"/api/sources/{source_id}/segments/material-provenance/matches"
        result = await client.post(matches_url, json=reference)
        assert result.status_code == 200, result.text
        assert len(result.json()["segments"]) == 20 and result.json()["truncated"] is True
        last_url = f"/api/segments/{created[-1]['id']}"
        assert (await client.delete(last_url)).status_code == 204
        result = await client.post(matches_url, json=reference)
        assert result.status_code == 200, result.text
        assert {item["id"] for item in result.json()["segments"]} == {
            segment["id"] for segment in created[:-1]
        }
        assert result.json()["truncated"] is False
        assert (
            await client.post(last_url + "/material-provenance/select", json=reference)
        ).status_code == 404
        assert (await client.delete(f"/api/sources/{source_id}")).status_code == 204
        active_url = f"/api/segments/{created[0]['id']}"
        assert (await client.get(active_url + "/material-provenance")).status_code == 404
        assert (
            await client.post(active_url + "/material-provenance/select", json=reference)
        ).status_code == 404
        assert (await client.post(matches_url, json=reference)).status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("interleaved", [False, True])
async def test_one_range_can_cross_parts_only_without_intervening_text(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, interleaved: bool
) -> None:
    book = compiled_provenance(b"")
    original = book.chapters[0].parts[0]
    parts = [original.model_copy(update={"end": 1})]
    if interleaved:
        parts.append(book.chapters[0].parts[1].model_copy(update={"end": 1}))
    parts.append(original.model_copy(update={"start": 1}))
    chapter = book.chapters[0].model_copy(update={"parts": parts})
    book = book.model_copy(update={"chapters": [chapter]})

    def compile_parts(_data: bytes) -> CompiledBook:
        return book

    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compile_parts)
    database = tmp_path / "parts.db"
    async with api_client(database) as client:
        source_id, material = await setup_material(client)
        result = await create_segment(client, source_id, provenance(material, span("r1", 0, 0, 2)))
        if interleaved:
            assert result.status_code == 422, result.text
            assert row_counts(database) == (0, 0)
        else:
            assert result.status_code == 201, result.text
            resolved = await client.get(f"/api/segments/{result.json()['id']}/material-provenance")
            assert resolved.status_code == 200 and resolved.json()["status"] == "resolved"
            assert [
                (part["part_index"], part["start"], part["end"])
                for part in resolved.json()["parts"]
            ] == [(0, 0, 1), (1, 1, 2)]


@pytest.mark.asyncio
@pytest.mark.parametrize("corruption", ["json", "exact", "hash", "segment"])
async def test_persisted_snapshot_is_checked_before_matching_or_selecting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, corruption: str
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    database = tmp_path / "stored.db"
    async with api_client(database) as client:
        source_id, material = await setup_material(client)
        reference = provenance(material)
        created = await create_segment(client, source_id, reference)
        assert created.status_code == 201, created.text
        saved = created.json()
    with sqlite3.connect(database) as connection:
        if corruption == "segment":
            connection.execute(
                "UPDATE segments SET text='過去の異なる原文' WHERE id=?", (saved["id"],)
            )
        else:
            payload = saved["material_provenance"]
            if corruption != "json":
                payload["ranges"][0]["exact" if corruption == "exact" else "text_sha256"] = "b" * 64
            connection.execute(
                "UPDATE segment_material_provenance SET payload=? WHERE segment_id=?",
                ("broken-json" if corruption == "json" else json.dumps(payload), saved["id"]),
            )
        connection.commit()
    async with api_client(database) as client:
        url = f"/api/segments/{saved['id']}"
        reread = await client.get(url)
        assert reread.status_code == 200, reread.text
        assert reread.json()["text"] == ("過去の異なる原文" if corruption == "segment" else "が𠮷")
        resolved = await client.get(url + "/material-provenance")
        assert resolved.status_code == 200, resolved.text
        assert resolved.json()["status"] == (
            "invalid_reference" if corruption == "json" else "snapshot_mismatch"
        )
        matched = await client.post(
            f"/api/sources/{source_id}/segments/material-provenance/matches", json=reference
        )
        assert matched.status_code == 200 and matched.json()["segments"] == []
        selected = await client.post(url + "/material-provenance/select", json=reference)
        assert selected.status_code == 409, selected.text


@pytest.mark.parametrize(
    ("texts", "spines", "target_part", "start", "expected"),
    [
        (["0123456789"], [0], 0, 0, "章 · 章内约 0%"),
        (["0123456789"], [0], 0, 3, "章 · 章内约 30%"),
        (["0123456789"], [0], 0, 9, "章 · 章内约 90%"),
        (["𠮷甲乙"], [0], 0, 1, "章 · 章内约 33%"),
        (["甲" * 101], [0], 0, 100, "章 · 章内约 99%"),
        (["0123456789"], [0, 0], 1, 3, "章 · 章内约 65%"),
        (["前か", "\u3099𠮷後"], [0, 1], 1, 1, "章 · 章内约 50%"),
        (["前か", "\u3099𠮷後"], [0, 1], 1, 0, "章"),
        (["前", "か\u0315", "\u3099後"], [0, 1, 2], 2, 0, "章"),
        ([""], [0], 0, 0, "章"),
    ],
)
def test_chapter_location_uses_whole_nfc_codepoints_and_occurrences(
    texts: list[str], spines: list[int], target_part: int, start: int, expected: str
) -> None:
    base = compiled_provenance(b"")
    resources = [
        base.resources[0].model_copy(
            update={
                "id": f"r{index}",
                "text": text,
                "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
            }
        )
        for index, text in enumerate(texts)
    ]
    occurrences = [resources[index] for index in spines]
    parts = [
        base.chapters[0]
        .parts[0]
        .model_copy(
            update={
                "resource_id": resource.id,
                "spine_index": index,
                "start": 0,
                "end": len(resource.text),
            }
        )
        for index, resource in enumerate(occurrences)
    ]
    chapter = base.chapters[0].model_copy(update={"title": "章", "parts": parts})
    book = base.model_copy(update={"resources": occurrences, "chapters": [chapter]})
    target = parts[target_part]
    projections = [
        ProvenancePart(
            range_index=0,
            part_index=target_part,
            resource_id=target.resource_id,
            spine_index=target.spine_index,
            start=start,
            end=min(start + 1, target.end),
        )
    ]
    original = book.model_dump()
    assert provenance_service.chapter_location(book, chapter.id, projections) == expected
    assert book.model_dump() == original


def test_chapter_location_uses_part_slices_and_only_first_projection_start() -> None:
    base = compiled_provenance(b"")
    text = "0123456789"
    resource = base.resources[0].model_copy(
        update={"text": text, "text_sha256": hashlib.sha256(text.encode()).hexdigest()}
    )
    original = base.chapters[0].parts[0]
    parts = [
        original.model_copy(update={"start": 2, "end": 5}),
        original.model_copy(update={"start": 5, "end": 8}),
    ]
    chapter = base.chapters[0].model_copy(update={"parts": parts})
    book = base.model_copy(update={"resources": [resource], "chapters": [chapter]})
    projected = [
        ProvenancePart(
            range_index=0,
            part_index=index,
            resource_id=resource.id,
            spine_index=0,
            start=start,
            end=end,
        )
        for index, (start, end) in enumerate([(3, 5), (5, 7)])
    ]
    assert provenance_service.chapter_location(book, chapter.id, projected) == "同じ章 · 章内约 16%"


@pytest.mark.asyncio
async def test_resolved_nfc_seam_keeps_exact_location_but_omits_unrepresentable_percentage(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    async with api_client(tmp_path / "nfc-display.db") as client:
        source_id, material = await setup_material(client)
        created = await create_segment(client, source_id, provenance(material, span("r2", 1, 0, 1)))
        assert created.status_code == 201, created.text
        saved = created.json()
        resolved = (await client.get(f"/api/segments/{saved['id']}/material-provenance")).json()
        assert resolved["status"] == "resolved"
        assert resolved["display"] == "引用検証 · 同じ章"
        assert resolved["material_provenance"] == saved["material_provenance"]
        assert resolved["parts"][0]["start"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("material_title", "chapter_title", "expected"),
    [
        ("", "同じ章", "同じ章 · 章内约 16%"),
        ("引用検証", "", "引用検証 · 章内约 16%"),
        (" \t", " \t", "章内约 16%"),
    ],
)
async def test_display_omits_empty_title_items(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    material_title: str,
    chapter_title: str,
    expected: str,
) -> None:
    def compile_titles(_data: bytes) -> CompiledBook:
        book = compiled_provenance(b"")
        return book.model_copy(
            update={
                "chapters": [
                    book.chapters[0].model_copy(update={"title": chapter_title}),
                    *book.chapters[1:],
                ]
            }
        )

    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compile_titles)
    database = tmp_path / "empty-titles.db"
    async with api_client(database) as client:
        source_id, material = await setup_material(client)
        created = await create_segment(client, source_id, provenance(material))
        assert created.status_code == 201, created.text
        saved = created.json()
        with sqlite3.connect(database) as connection:
            connection.execute(
                "UPDATE materials SET title=? WHERE id=?", (material_title, material["id"])
            )
            connection.commit()
        resolved = (await client.get(f"/api/segments/{saved['id']}/material-provenance")).json()
        assert resolved["status"] == "resolved"
        assert resolved["display"] == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("mutation", ["rename", "material_source", "origin_source"])
async def test_display_uses_current_name_and_never_exposes_foreign_material_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mutation: str
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    database = tmp_path / "display.db"
    async with api_client(database) as client:
        source_id, material = await setup_material(client)
        created = await create_segment(client, source_id, provenance(material), source_ref="追記")
        saved = created.json()
        other = (await client.post("/api/sources", json={"title": "別の出典"})).json()["id"]
    with sqlite3.connect(database) as connection:
        if mutation == "rename":
            connection.execute(
                "UPDATE materials SET title='現在の題名' WHERE id=?", (material["id"],)
            )
        elif mutation == "material_source":
            connection.execute(
                "UPDATE materials SET source_id=? WHERE id=?", (other, material["id"])
            )
        else:
            connection.execute(
                "UPDATE segment_material_provenance SET source_id=? WHERE segment_id=?",
                (other, saved["id"]),
            )
        connection.commit()
    async with api_client(database) as client:
        url = f"/api/segments/{saved['id']}"
        resolved = (await client.get(url + "/material-provenance")).json()
        assert resolved["status"] == ("resolved" if mutation == "rename" else "invalid_reference")
        assert resolved["display"] == (
            "現在の題名 · 同じ章 · 章内约 16%" if mutation == "rename" else None
        )
        reread = (await client.get(url)).json()
        assert reread["material_provenance"] == saved["material_provenance"]
        assert reread["source_ref"] == "追記"
