"""Book record searches use current values, exact origins and literal Unicode queries."""

import asyncio
import sqlite3
import threading
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from httpx import AsyncClient
from support_api import chat_client
from support_reader_books import anchor, bookmark_book
from support_segment_provenance import (
    compiled_provenance,
    create_segment,
    provenance,
    setup_material,
    span,
)
from support_translations import seed_result

from app.epub_schemas import CompiledBook
from app.provenance_schemas import MaterialProvenance
from app.record_search_schemas import MaterialRecordSearchItem, RecordSearchKind
from app.services import record_search
from app.services.material_provenance import identity_sha256


def endpoint(material: dict[str, Any]) -> str:
    return f"/api/materials/{material['id']}/record-search"


async def search(
    client: AsyncClient,
    material: dict[str, Any],
    kind: str,
    query: str = "",
    **options: Any,
) -> dict[str, Any]:
    response = await client.get(
        endpoint(material),
        params={"version_id": material["version_id"], "kind": kind, "q": query, **options},
    )
    assert response.status_code == 200, response.text
    return response.json()


async def another_material(client: AsyncClient, source: str) -> dict[str, Any]:
    uploaded = await client.post(
        f"/api/sources/{source}/materials",
        content=b"another immutable EPUB",
        headers={"content-type": "application/epub+zip"},
    )
    assert uploaded.status_code == 200, uploaded.text
    return uploaded.json()["material"]


def ids(page: dict[str, Any], field: str) -> list[str]:
    return [item[field] for item in page["items"]]


@pytest.mark.asyncio
async def test_segments_match_current_fields_once_with_literal_nfc_queries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    async with chat_client(tmp_path / "segments.db") as (client, _app):
        source, material = await setup_material(client)
        saved = await create_segment(
            client,
            source,
            provenance(material),
            translation="が𠮷 [.*] 100% _ ' OR 1=1 -- Ａ",
            note="が𠮷 [.*]",
            context_before="仅上下文关键词",
            source_ref="仅出处名关键词",
        )
        assert saved.status_code == 201, saved.text
        segment = saved.json()
        unrelated = await create_segment(client, source, provenance(material, span("r3", 3, 0, 2)))
        assert unrelated.status_code == 201, unrelated.text
        for query in ("  か\u3099𠮷  ", "[.*]", "100%", "_", "' OR 1=1 --", "Ａ"):
            page = await search(client, material, "segment", query)
            assert page["total"] == 1 and ids(page, "segment_id") == [segment["id"]]
            assert page["items"][0]["material_provenance"] == segment["material_provenance"]
        for query in ("A", "仅上下文关键词", "仅出处名关键词", "%missing", "不存在"):
            assert (await search(client, material, "segment", query))["total"] == 0
        browse = await search(client, material, "segment", "  ")
        assert browse["total"] == 2
        patched = await client.patch(
            f"/api/segments/{segment['id']}",
            json={"expected_revision": segment["revision"], "translation": "新译文", "note": ""},
        )
        assert patched.status_code == 200, patched.text
        assert (await search(client, material, "segment", "[.*]"))["total"] == 0
        assert (await search(client, material, "segment", "新译文"))["total"] == 1
        assert (await client.delete(f"/api/segments/{segment['id']}")).status_code == 204
        assert ids(await search(client, material, "segment"), "segment_id") == [
            unrelated.json()["id"]
        ]


@pytest.mark.asyncio
async def test_source_excerpt_only_accompanies_translation_or_note_snippets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    async with chat_client(tmp_path / "source-excerpts.db") as (client, app):
        source, material = await setup_material(client)
        saved = await create_segment(
            client, source, provenance(material), translation="辅助译文", note="私人备注"
        )
        assert saved.status_code == 201, saved.text
        original = saved.json()["text"]
        for query in ("", original):
            page = await search(client, material, "segment", query)
            assert page["items"][0]["source_excerpt"] is None
        for query in ("辅助译文", "私人备注"):
            page = await search(client, material, "segment", query)
            assert page["items"][0]["snippet"] == query
            assert page["items"][0]["source_excerpt"] == original

        created = await client.post(
            f"/api/materials/{material['id']}/bookmarks",
            json={"request_id": str(uuid4()), "position": anchor(material["version_id"], offset=0)},
        )
        assert created.status_code == 200, created.text
        bookmark = created.json()
        edited = await client.patch(
            f"/api/materials/{material['id']}/bookmarks/{bookmark['id']}",
            json={"expected_revision": bookmark["revision"], "note": "书签备注"},
        )
        assert edited.status_code == 200, edited.text
        for query in ("", bookmark["excerpt"]):
            page = await search(client, material, "bookmark", query)
            assert page["items"][0]["source_excerpt"] is None
        page = await search(client, material, "bookmark", "书签备注")
        assert page["items"][0]["source_excerpt"] == bookmark["excerpt"]

        await seed_result(app, source, provenance(material), 1)
        page = await search(client, material, "translation")
        assert page["items"][0]["source_excerpt"] == original


@pytest.mark.asyncio
async def test_segments_require_exact_material_and_version_association(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    database = tmp_path / "association.db"
    async with chat_client(database) as (client, _app):
        source, material = await setup_material(client)
        other = await another_material(client, source)
        assert other["id"] != material["id"]
        current = await create_segment(client, source, provenance(material), note="同一关键词")
        sibling = await create_segment(client, source, provenance(other), note="同一关键词")
        stale = await create_segment(client, source, provenance(material), note="同一关键词")
        manual = await client.post(
            f"/api/sources/{source}/segments",
            json={"text": "が𠮷", "note": "同一关键词", "source_ref": "引用検証"},
        )
        assert [item.status_code for item in (current, sibling, stale, manual)] == [201] * 4
        with sqlite3.connect(database) as connection:
            connection.execute(
                "UPDATE segment_material_provenance SET version_id='old-version' "
                "WHERE segment_id=?",
                (stale.json()["id"],),
            )
            connection.commit()
        page = await search(client, material, "segment", "同一关键词")
        assert page["total"] == 1 and ids(page, "segment_id") == [current.json()["id"]]
        other_page = await search(client, other, "segment", "同一关键词")
        assert other_page["total"] == 1 and ids(other_page, "segment_id") == [sibling.json()["id"]]


@pytest.mark.asyncio
async def test_translations_choose_latest_success_before_search_and_hide_removed_targets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    database = tmp_path / "translations.db"
    async with chat_client(database) as (client, app):
        source, material = await setup_material(client)
        reference = provenance(material)
        await seed_result(app, source, reference, 1)
        latest = await seed_result(app, source, reference, 2)
        await seed_result(app, source, reference, 3, status="failed")
        repeated = provenance(material, span("r1", 2, 0, 2))
        repeated_id = await seed_result(app, source, repeated, 4)
        chapter_two = await seed_result(app, source, provenance(material, span("r3", 3, 0, 2)), 5)
        other = await another_material(client, source)
        await seed_result(app, source, provenance(other), 6)
        with sqlite3.connect(database) as connection:
            connection.execute(
                "UPDATE translation_results SET translation='历史独有词' WHERE id=?", (f"{1:026d}",)
            )
            connection.execute(
                "UPDATE translation_results SET translation='最新 [.*] が𠮷' WHERE id=?", (latest,)
            )
            connection.execute(
                "UPDATE translation_results SET translation='失败独有词' WHERE id=?", (f"{3:026d}",)
            )
            connection.commit()
        assert (await search(client, material, "translation", "历史独有词"))["total"] == 0
        assert (await search(client, material, "translation", "失败独有词"))["total"] == 0
        assert (await search(client, material, "translation", "译文6"))["total"] == 0
        for query in ("[.*]", " か\u3099𠮷 "):
            page = await search(client, material, "translation", query)
            assert page["total"] == 1 and ids(page, "result_id") == [latest]
        browse = await search(client, material, "translation")
        assert browse["total"] == 3 and ids(browse, "result_id") == [
            latest,
            repeated_id,
            chapter_two,
        ]
        assert (await search(client, material, "translation", "が𠮷"))["total"] == 1
        removal = await client.delete(
            f"/api/materials/{material['id']}/translations/"
            f"{identity_sha256(MaterialProvenance.model_validate(reference))}"
        )
        assert removal.status_code == 200, removal.text
        assert (await search(client, material, "translation", "[.*]"))["total"] == 0
        assert ids(await search(client, material, "translation"), "result_id") == [
            repeated_id,
            chapter_two,
        ]


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["segment", "translation"])
async def test_record_chapter_filters_count_before_position_ordered_pagination(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    async with chat_client(tmp_path / f"{kind}-pages.db") as (client, app):
        source, material = await setup_material(client)
        references = [
            provenance(material, span("r1", 0, 0, 1)),
            provenance(material),
            provenance(material, span("r1", 2, 0, 2)),
            provenance(material, span("r3", 3, 0, 2)),
        ]
        expected: list[str] = []
        for ordinal in reversed(range(4)):
            if kind == "segment":
                response = await create_segment(client, source, references[ordinal])
                assert response.status_code == 201, response.text
                value = response.json()["id"]
            else:
                value = await seed_result(app, source, references[ordinal], ordinal + 1)
            expected.insert(0, value)
        field = "segment_id" if kind == "segment" else "result_id"
        whole = await search(client, material, kind, offset=1, limit=2)
        assert whole["total"] == 4 and ids(whole, field) == expected[1:3]
        selected = await search(
            client, material, kind, chapter_ids=["c2", "c1", "c2"], offset=2, limit=2
        )
        assert selected["total"] == 4 and ids(selected, field) == expected[2:]
        first = await search(client, material, kind, chapter_ids=["c1"], offset=1, limit=1)
        assert first["total"] == 3 and ids(first, field) == expected[1:2]
        last = await search(client, material, kind, chapter_ids=["c2"])
        assert last["total"] == 1 and ids(last, field) == expected[3:]
        exhausted = await search(client, material, kind, chapter_ids=["c1"], offset=3)
        assert exhausted["total"] == 3 and exhausted["items"] == []


@pytest.mark.asyncio
async def test_bookmarks_search_excerpt_notes_and_preserve_real_image_positions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", bookmark_book)
    async with chat_client(tmp_path / "bookmarks.db") as (client, _app):
        source, material = await setup_material(client)
        url = f"/api/materials/{material['id']}/bookmarks"
        positions = [
            anchor(
                material["version_id"],
                chapter_id="c3",
                kind="image",
                offset=None,
                image_id=0,
                image_progress=0.25,
            ),
            anchor(material["version_id"]),
            anchor(material["version_id"], chapter_id="c2", offset=303),
        ]
        bookmarks: list[dict[str, Any]] = []
        for position in positions:
            response = await client.post(
                url, json={"request_id": str(uuid4()), "position": position}
            )
            assert response.status_code == 200, response.text
            bookmarks.append(response.json())
        image, text, last = bookmarks
        edited = await client.patch(
            url + "/" + image["id"], json={"expected_revision": 0, "note": "挿絵 & 図 [.*] が𠮷"}
        )
        assert edited.status_code == 200, edited.text
        both = await search(client, material, "bookmark", "挿絵 & 図")
        assert both["total"] == 1 and ids(both, "bookmark_id") == [image["id"]]
        item = both["items"][0]
        assert item["position"] == image["position"]
        assert item["position"]["kind"] == "image" and item["position"]["offset"] is None
        assert (await search(client, material, "bookmark", "[.*]"))["total"] == 1
        assert (await search(client, material, "bookmark", "か\u3099"))["total"] == 2
        browse = await search(client, material, "bookmark")
        assert browse["total"] == 3 and ids(browse, "bookmark_id") == [
            text["id"],
            last["id"],
            image["id"],
        ]
        filtered = await search(
            client, material, "bookmark", chapter_ids=["c3", "c1"], offset=1, limit=1
        )
        assert filtered["total"] == 2 and ids(filtered, "bookmark_id") == [image["id"]]
        cleared = await client.patch(
            url + "/" + image["id"], json={"expected_revision": 1, "note": ""}
        )
        assert cleared.status_code == 200, cleared.text
        assert (await search(client, material, "bookmark", "[.*]"))["total"] == 0
        assert (await search(client, material, "bookmark", "挿絵 & 図"))["total"] == 1
        deleted = await client.delete(url + "/" + image["id"], params={"expected_revision": 2})
        assert deleted.status_code == 204, deleted.text
        assert (await search(client, material, "bookmark", "挿絵 & 図"))["total"] == 0
        assert (await search(client, material, "bookmark"))["total"] == 2
        other = await another_material(client, source)
        assert (await search(client, other, "bookmark"))["total"] == 0


@pytest.mark.asyncio
async def test_record_search_bounds_stale_versions_and_deleted_ancestors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    async with chat_client(tmp_path / "gates.db") as (client, _app):
        source, material = await setup_material(client)
        params: dict[str, Any] = {"kind": "segment", "version_id": material["version_id"]}
        for invalid in (
            {"kind": "unknown"},
            {"q": "あ" * 161},
            {"offset": -1},
            {"limit": 0},
            {"limit": 101},
            {"chapter_ids": ["missing"]},
        ):
            response = await client.get(endpoint(material), params=params | invalid)
            assert response.status_code == 422, response.text
        assert (await client.get(endpoint(material), params={"kind": "segment"})).status_code == 422
        assert (
            await client.get(endpoint(material), params=params | {"version_id": "stale"})
        ).status_code == 409
        assert (await client.delete(f"/api/materials/{material['id']}")).status_code == 204
        for kind in ("segment", "translation", "bookmark"):
            assert (
                await client.get(endpoint(material), params=params | {"kind": kind})
            ).status_code == 404
        other = await another_material(client, source)
        assert (await client.delete(f"/api/sources/{source}")).status_code == 204
        assert (
            await client.get(
                endpoint(other), params={"kind": "bookmark", "version_id": other["version_id"]}
            )
        ).status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation",
    ["segment_edit", "segment_delete", "bookmark_delete", "translation_remove", "new_result"],
)
async def test_search_rechecks_records_after_cpu_scan_and_decodes_once_off_event_loop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mutation: str
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    async with chat_client(tmp_path / "race.db") as (client, app):
        source, material = await setup_material(client)
        reference = provenance(material)
        saved: dict[str, Any] = {}
        if mutation.startswith("segment"):
            kind: RecordSearchKind = "segment"
            response = await create_segment(client, source, reference, note="旧备注")
            assert response.status_code == 201, response.text
            saved = response.json()
        elif mutation == "bookmark_delete":
            kind = "bookmark"
            response = await client.post(
                f"/api/materials/{material['id']}/bookmarks",
                json={
                    "request_id": str(uuid4()),
                    "position": anchor(material["version_id"], offset=0),
                },
            )
            assert response.status_code == 200, response.text
            saved = response.json()
        else:
            kind = "translation"
            await seed_result(app, source, reference, 1)
        entered, release = threading.Event(), threading.Event()
        scan = record_search.scan_records
        decode = record_search.decode_epub
        decode_threads: list[int] = []
        main_thread = threading.get_ident()

        def observed_decode(bundle: bytes) -> CompiledBook:
            decode_threads.append(threading.get_ident())
            return decode(bundle)

        def delayed_scan(
            identity: record_search.MaterialIdentity,
            kind: RecordSearchKind,
            rows: list[record_search.Candidate],
            query: str,
            chapter_ids: list[str] | None,
        ) -> list[MaterialRecordSearchItem]:
            items = scan(identity, kind, rows, query, chapter_ids)
            entered.set()
            assert release.wait(5)
            return items

        monkeypatch.setattr(record_search, "decode_epub", observed_decode)
        monkeypatch.setattr(record_search, "scan_records", delayed_scan)
        pending = asyncio.create_task(
            client.get(
                endpoint(material), params={"version_id": material["version_id"], "kind": kind}
            )
        )
        assert await asyncio.to_thread(entered.wait, 5)
        try:
            if mutation == "segment_edit":
                changed = await client.patch(
                    f"/api/segments/{saved['id']}",
                    json={"expected_revision": saved["revision"], "note": "新备注"},
                )
                assert changed.status_code == 200, changed.text
            elif mutation == "segment_delete":
                assert (await client.delete(f"/api/segments/{saved['id']}")).status_code == 204
            elif mutation == "bookmark_delete":
                deleted = await client.delete(
                    f"/api/materials/{material['id']}/bookmarks/{saved['id']}",
                    params={"expected_revision": saved["revision"]},
                )
                assert deleted.status_code == 204, deleted.text
            elif mutation == "translation_remove":
                removed = await client.delete(
                    f"/api/materials/{material['id']}/translations/"
                    f"{identity_sha256(MaterialProvenance.model_validate(reference))}"
                )
                assert removed.status_code == 200, removed.text
            else:
                await seed_result(app, source, reference, 2)
        finally:
            release.set()
        response = await pending
        assert response.status_code == 200, response.text
        assert response.json()["total"] == 0 and response.json()["items"] == []
        assert len(decode_threads) == 1 and decode_threads[0] != main_thread
        monkeypatch.setattr(record_search, "scan_records", scan)
        refreshed = await search(client, material, kind)
        assert refreshed["total"] == int(mutation in {"segment_edit", "new_result"})
        if mutation == "new_result":
            assert ids(refreshed, "result_id") == [f"{2:026d}"]


@pytest.mark.asyncio
async def test_record_queries_do_not_write_reading_usage_or_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    database = tmp_path / "read-only.db"
    async with chat_client(database) as (client, app):
        source, material = await setup_material(client)
        saved = await create_segment(client, source, provenance(material))
        assert saved.status_code == 201, saved.text
        await seed_result(app, source, provenance(material), 1)
        bookmark = await client.post(
            f"/api/materials/{material['id']}/bookmarks",
            json={"request_id": str(uuid4()), "position": anchor(material["version_id"], offset=0)},
        )
        assert bookmark.status_code == 200, bookmark.text

        def state() -> dict[str, list[Any]]:
            with sqlite3.connect(database) as connection:
                return {
                    table: connection.execute(f"SELECT * FROM {table}").fetchall()
                    for table in (
                        "materials",
                        "reading_positions",
                        "chapter_reading_positions",
                        "material_usage",
                        "runs",
                    )
                }

        before = state()
        for kind in ("segment", "translation", "bookmark"):
            assert (await search(client, material, kind))["total"] == 1
            assert (await search(client, material, kind, "不存在"))["total"] == 0
        assert state() == before
