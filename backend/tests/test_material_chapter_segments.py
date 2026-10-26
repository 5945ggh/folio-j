"""Offline chapter marking scans stay complete, exact, bounded and deletion-aware."""

import asyncio
import hashlib
import json
import sqlite3
import threading
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from test_segment_provenance import (
    compiled_provenance,
    create_segment,
    provenance,
    setup_material,
    span,
)
from test_source_segment import api_client

from app.epub_schemas import CompiledBook
from app.epub_storage import encode
from app.material_segment_schemas import MaterialChapterSegment
from app.services import material_segments


def endpoint(material: dict[str, Any], chapter: str = "c1") -> str:
    return f"/api/materials/{material['id']}/chapters/{chapter}/segments"


def clone_segment(database: Path, original_id: str, ordinal: int) -> str:
    """Give immutable API-created fixtures a deterministic keyset order in a temporary DB."""
    segment_id = f"{ordinal:026d}"
    with sqlite3.connect(database) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.row_factory = sqlite3.Row
        for table, key in (("segments", "id"), ("segment_material_provenance", "segment_id")):
            row = connection.execute(
                f"SELECT * FROM {table} WHERE {key}=?", (original_id,)
            ).fetchone()
            assert row is not None
            values = dict(row)
            values[key] = segment_id
            if table == "segment_material_provenance":
                request_id = str(uuid4())
                values["request_id"] = request_id
                request = json.loads(values["request_payload"])
                values["request_payload"] = json.dumps({**request, "request_id": request_id})
            columns = ",".join(values)
            placeholders = ",".join("?" for _ in values)
            connection.execute(
                f"INSERT INTO {table} ({columns}) VALUES ({placeholders})", tuple(values.values())
            )
        connection.commit()
    return segment_id


@pytest.mark.asyncio
async def test_pages_scan_all_segments_without_twenty_item_truncation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    database = tmp_path / "pages.db"
    async with api_client(database) as client:
        source_id, material = await setup_material(client)
        templates: list[dict[str, Any]] = []
        for reference in (
            provenance(material),
            provenance(material, span("r1", 0, 0, 2)),
            provenance(material, span("r1", 2, 0, 2)),
            provenance(material, span("r3", 3, 0, 2)),
        ):
            saved = await create_segment(client, source_id, reference)
            assert saved.status_code == 201, saved.text
            templates.append(saved.json())
        other_chapter = [clone_segment(database, templates[3]["id"], index) for index in range(2)]
        expected = [
            clone_segment(database, templates[index % 3]["id"], index + 2) for index in range(105)
        ]
        for template in templates:
            assert (await client.delete(f"/api/segments/{template['id']}")).status_code == 204
        manual = await client.post(f"/api/sources/{source_id}/segments", json={"text": "が𠮷"})
        assert manual.status_code == 201, manual.text
        with sqlite3.connect(database) as connection:
            connection.execute("DELETE FROM material_readings_current")
            connection.execute("DELETE FROM material_readings_generations")
            connection.commit()
        params: dict[str, Any] = {"version_id": material["version_id"]}
        empty = await client.get(endpoint(material), params={**params, "limit": 1})
        assert empty.status_code == 200, empty.text
        assert empty.json() == {
            "items": [],
            "next_cursor": other_chapter[0],
            "unavailable_count": 0,
        }
        next_empty = await client.get(
            endpoint(material), params={**params, "limit": 1, "after": empty.json()["next_cursor"]}
        )
        assert next_empty.status_code == 200 and next_empty.json()["items"] == []
        assert next_empty.json()["next_cursor"] == other_chapter[1]

        calls = 0
        decode = material_segments.decode_epub

        def count_decode(data: bytes) -> CompiledBook:
            nonlocal calls
            calls += 1
            return decode(data)

        monkeypatch.setattr(material_segments, "decode_epub", count_decode)
        page = await client.get(endpoint(material), params=params)
        assert page.status_code == 200, page.text
        assert calls == 1
        assert len(page.json()["items"]) == 98
        assert page.json()["next_cursor"] == expected[97]
        assert page.json()["unavailable_count"] == 0
        second = await client.get(
            endpoint(material), params={**params, "after": page.json()["next_cursor"]}
        )
        assert second.status_code == 200 and second.json()["next_cursor"] is None
        all_items = page.json()["items"] + second.json()["items"]
        assert [item["segment_id"] for item in all_items] == expected
        assert all(len(item["excerpt"]) <= 160 for item in all_items)
        assert {
            entry["spine_index"]
            for item in all_items
            for entry in item["material_provenance"]["ranges"]
        } == {0, 1, 2}
        assert (
            len(
                [
                    item
                    for item in all_items
                    if item["material_provenance"] == templates[0]["material_provenance"]
                ]
            )
            == 35
        )
        chapter_two = await client.get(endpoint(material, "c2"), params=params)
        assert [item["segment_id"] for item in chapter_two.json()["items"]] == other_chapter
        assert chapter_two.json()["next_cursor"] is not None
        assert chapter_two.json()["unavailable_count"] == 0
        with sqlite3.connect(database) as connection:
            for table in ("chat_threads", "chat_jobs", "runs"):
                assert connection.execute(f"SELECT count(*) FROM {table}").fetchone() == (0,)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "corruption", ["json", "exact", "hash", "version", "text", "assembly", "source", "spine"]
)
async def test_invalid_saved_references_are_counted_without_markers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, corruption: str
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    database = tmp_path / "invalid.db"
    async with api_client(database) as client:
        source_id, material = await setup_material(client)
        result = await create_segment(client, source_id, provenance(material))
        assert result.status_code == 201, result.text
        saved = result.json()
        corrupted = clone_segment(database, saved["id"], 1)
        with sqlite3.connect(database) as connection:
            if corruption == "text":
                connection.execute("UPDATE segments SET text='違う原文' WHERE id=?", (corrupted,))
            elif corruption in {"assembly", "source", "version"}:
                column = {
                    "assembly": "assembly_rule",
                    "source": "source_id",
                    "version": "version_id",
                }[corruption]
                connection.execute(
                    f"UPDATE segment_material_provenance SET {column}='wrong' WHERE segment_id=?",
                    (corrupted,),
                )
            else:
                reference = saved["material_provenance"]
                if corruption == "exact":
                    reference["ranges"][0]["exact"] = "違う"
                elif corruption == "hash":
                    reference["ranges"][0]["text_sha256"] = "b" * 64
                elif corruption == "spine":
                    reference["ranges"][0]["spine_index"] = 2
                connection.execute(
                    "UPDATE segment_material_provenance SET payload=? WHERE segment_id=?",
                    ("invalid-json" if corruption == "json" else json.dumps(reference), corrupted),
                )
            connection.commit()
        first = await client.get(
            endpoint(material), params={"version_id": material["version_id"], "limit": 1}
        )
        assert first.status_code == 200, first.text
        assert first.json() == {"items": [], "next_cursor": corrupted, "unavailable_count": 1}
        next_page = await client.get(
            endpoint(material),
            params={"version_id": material["version_id"], "after": corrupted, "limit": 1},
        )
        assert next_page.status_code == 200, next_page.text
        assert [item["segment_id"] for item in next_page.json()["items"]] == [saved["id"]]
        assert (
            next_page.json()["next_cursor"] is None and next_page.json()["unavailable_count"] == 0
        )


@pytest.mark.asyncio
async def test_version_chapter_limits_and_ancestor_gates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    async with api_client(tmp_path / "gates.db") as client:
        source_id, material = await setup_material(client)
        url, params = endpoint(material), {"version_id": material["version_id"]}
        assert (await client.get(url, params={"version_id": "wrong"})).status_code == 409
        assert (await client.get(endpoint(material, "missing"), params=params)).status_code == 404
        for invalid in (
            {},
            {"limit": 0},
            {"limit": 101},
            {"limit": "x"},
            {"after": "bad"},
            {"version_id": ""},
        ):
            supplied = invalid if not invalid else {**params, **invalid}
            assert (await client.get(url, params=supplied)).status_code == 422
        assert (await client.delete(f"/api/materials/{material['id']}")).status_code == 204
        assert (await client.get(url, params=params)).status_code == 404
        fresh = (
            await client.post(
                f"/api/sources/{source_id}/materials",
                content=b"new",
                headers={"content-type": "application/epub+zip"},
            )
        ).json()["material"]
        assert (await client.delete(f"/api/sources/{source_id}")).status_code == 204
        assert (
            await client.get(endpoint(fresh), params={"version_id": fresh["version_id"]})
        ).status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation", ["material", "source", "segment", "version", "bundle", "payload", "context"]
)
async def test_final_read_rechecks_visibility_and_immutable_content(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mutation: str
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    database = tmp_path / "race.db"
    async with api_client(database) as client:
        source_id, material = await setup_material(client)
        created = await create_segment(client, source_id, provenance(material))
        assert created.status_code == 201, created.text
        saved = created.json()
        entered, release = threading.Event(), threading.Event()
        validate = material_segments.validate_page

        def delayed(
            identity: material_segments.MaterialIdentity,
            chapter: str,
            rows: list[material_segments.Candidate],
        ) -> dict[str, tuple[MaterialChapterSegment | None, bool]]:
            result = validate(identity, chapter, rows)
            entered.set()
            assert release.wait(5), "chapter validation was not released"
            return result

        monkeypatch.setattr(material_segments, "validate_page", delayed)
        task = asyncio.create_task(
            client.get(endpoint(material), params={"version_id": material["version_id"]})
        )
        assert await asyncio.to_thread(entered.wait, 5)
        try:
            if mutation in {"material", "source", "segment"}:
                target = {
                    "material": f"/api/materials/{material['id']}",
                    "source": f"/api/sources/{source_id}",
                    "segment": f"/api/segments/{saved['id']}",
                }[mutation]
                assert (await client.delete(target)).status_code == 204
            elif mutation == "context":
                assert (
                    await client.patch(
                        f"/api/segments/{saved['id']}",
                        json={
                            "context_before": "編集した語境",
                            "expected_revision": saved["revision"],
                        },
                    )
                ).status_code == 200
            else:
                with sqlite3.connect(database, timeout=2) as connection:
                    if mutation == "version":
                        connection.execute(
                            "UPDATE materials SET version_id='changed' WHERE id=?",
                            (material["id"],),
                        )
                    elif mutation == "bundle":
                        connection.execute(
                            "UPDATE materials SET compiled_bundle=? WHERE id=?",
                            (b"changed", material["id"]),
                        )
                    else:
                        connection.execute(
                            "UPDATE segment_material_provenance SET payload='invalid' "
                            "WHERE segment_id=?",
                            (saved["id"],),
                        )
                    connection.commit()
        finally:
            release.set()
        result = await task
        expected_status = (
            404
            if mutation in {"material", "source"}
            else 409
            if mutation in {"version", "bundle"}
            else 200
        )
        assert result.status_code == expected_status, result.text
        if result.status_code == 200:
            assert [item["segment_id"] for item in result.json()["items"]] == (
                [saved["id"]] if mutation == "context" else []
            )
            assert result.json()["unavailable_count"] == int(mutation == "payload")


@pytest.mark.asyncio
async def test_excerpt_uses_codepoints_and_other_sources_are_never_exposed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    text = "𠮷" * 201
    book = compiled_provenance(b"")
    resource = book.resources[0].model_copy(
        update={"text": text, "text_sha256": hashlib.sha256(text.encode()).hexdigest()}
    )
    chapter = book.chapters[0].model_copy(
        update={"parts": [book.chapters[0].parts[0].model_copy(update={"end": len(text)})]}
    )
    book = book.model_copy(update={"resources": [resource], "chapters": [chapter]})

    def compile_long(_data: bytes) -> CompiledBook:
        return book

    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compile_long)
    database = tmp_path / "long.db"
    async with api_client(database) as client:
        source_id, material = await setup_material(client)
        reference = provenance(
            material,
            {
                "resource_id": "r1",
                "spine_index": 0,
                "start": 0,
                "end": len(text),
                "exact": text,
                "text_sha256": resource.text_sha256,
            },
        )
        created = await create_segment(client, source_id, reference)
        assert created.status_code == 201, created.text
        saved = created.json()
        foreign_id = (await client.post("/api/sources", json={"title": "別の来源"})).json()["id"]
        foreign_segment = clone_segment(database, saved["id"], 1)
        with sqlite3.connect(database) as connection:
            connection.execute(
                "UPDATE segments SET source_id=? WHERE id=?", (foreign_id, foreign_segment)
            )
            connection.commit()
        result = await client.get(endpoint(material), params={"version_id": material["version_id"]})
        assert result.status_code == 200, result.text
        assert result.json()["unavailable_count"] == 0 and result.json()["next_cursor"] is None
        assert len(result.json()["items"]) == 1
        item = result.json()["items"][0]
        assert item["segment_id"] == saved["id"] and item["excerpt"] == "𠮷" * 160
        assert item["material_provenance"]["ranges"][0]["exact"] == text


@pytest.mark.asyncio
@pytest.mark.parametrize("corruption", ["bundle", "product", "resource"])
async def test_corrupt_material_cannot_emit_exact_markers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, corruption: str
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    database = tmp_path / "bad-book.db"
    async with api_client(database) as client:
        source_id, material = await setup_material(client)
        created = await create_segment(client, source_id, provenance(material))
        assert created.status_code == 201, created.text
        with sqlite3.connect(database) as connection:
            if corruption == "product":
                connection.execute(
                    "UPDATE materials SET product_sha256=? WHERE id=?", ("b" * 64, material["id"])
                )
            else:
                book = compiled_provenance(b"")
                changed = book.resources[0].model_copy(update={"text": "前き"})
                book = book.model_copy(update={"resources": [changed, *book.resources[1:]]})
                connection.execute(
                    "UPDATE materials SET compiled_bundle=? WHERE id=?",
                    (
                        b"broken" if corruption == "bundle" else encode(book),
                        material["id"],
                    ),
                )
            connection.commit()
        result = await client.get(endpoint(material), params={"version_id": material["version_id"]})
        assert result.status_code == (200 if corruption == "resource" else 409), result.text
        if result.status_code == 200:
            assert result.json() == {"items": [], "next_cursor": None, "unavailable_count": 1}
