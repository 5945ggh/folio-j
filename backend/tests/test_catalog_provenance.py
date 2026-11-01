"""Catalog provenance is batched, reliable, and guarded after expensive validation."""

import asyncio
import json
import sqlite3
import threading
from pathlib import Path

import pytest
from support_api import api_client
from test_segment_provenance import (
    compiled_provenance,
    create_segment,
    provenance,
    setup_material,
)

from app.epub_schemas import CompiledBook
from app.services import material_provenance as service


@pytest.mark.asyncio
async def test_catalog_provenance_batch_names_manual_fallback_and_counts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    async with api_client(tmp_path / "names.db") as client:
        source, material = await setup_material(client)
        linked_ids: list[str] = []
        for ref in ("手填页码", "", ""):
            saved = await create_segment(client, source, provenance(material), source_ref=ref)
            assert saved.status_code == 201, saved.text
            linked_ids.append(saved.json()["id"])
        manual_ids: list[str] = []
        for ref in ("手动书名", ""):
            saved = await client.post(
                f"/api/sources/{source}/segments", json={"text": "手动原文", "source_ref": ref}
            )
            manual_ids.append(saved.json()["id"])
        calls = 0
        original_decode = service.decode_epub

        def decode(data: bytes) -> CompiledBook:
            nonlocal calls
            calls += 1
            return original_decode(data)

        monkeypatch.setattr(service, "decode_epub", decode)
        url = f"/api/sources/{source}/catalog/segments"
        page = (await client.get(url)).json()
        assert page["total"] == 5 and calls == 1
        items = {item["id"]: item for item in page["items"]}
        expected = {
            "display": "引用検証 · 同じ章 · 章内约 16%",
            "title": "引用検証",
            "chapter_title": "同じ章",
            "chapter_percent": 16,
            "status": "resolved",
        }
        # Position uses the complete NFC chapter, including repeated spine occurrences.
        assert items[linked_ids[0]]["provenance_summary"] == expected
        assert items[linked_ids[0]]["source_ref"] == "手填页码"
        for sid in manual_ids:
            assert items[sid]["provenance_summary"] == {
                "display": None,
                "title": None,
                "chapter_title": None,
                "chapter_percent": None,
                "status": "none",
            }
        assert items[manual_ids[0]]["source_ref"] == "手动书名"
        renamed = await client.patch(
            f"/api/materials/{material['id']}/metadata",
            json={"title": "改名书籍", "expected_revision": 0},
        )
        assert renamed.status_code == 200, renamed.text
        page = (await client.get(url)).json()
        assert page["total"] == 5
        assert all(
            item["provenance_summary"]["title"] == "改名书籍"
            for item in page["items"]
            if item["id"] in linked_ids
        )
        assert (await client.delete(f"/api/materials/{material['id']}")).status_code == 204
        page = (await client.get(url)).json()
        assert page["total"] == 5
        for item in page["items"]:
            if item["id"] in linked_ids:
                assert item["provenance_summary"] == {
                    "display": "改名书籍",
                    "title": "改名书籍",
                    "chapter_title": None,
                    "chapter_percent": None,
                    "status": "material_deleted",
                }
        counts = (await client.get("/api/catalog/sources")).json()["items"][0]
        assert (counts["material_count"], counts["segment_count"]) == (0, 5)
        filtered = (await client.get(url, params={"q": "手填页码"})).json()
        assert filtered["total"] == 1 and filtered["items"][0]["id"] == linked_ids[0]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("damage", "status", "title"),
    [
        ("bundle", "snapshot_mismatch", "引用検証"),
        ("version", "version_unavailable", "引用検証"),
        ("payload", "invalid_reference", None),
        ("cross_source", "invalid_reference", None),
        ("snapshot", "snapshot_mismatch", "引用検証"),
    ],
)
async def test_catalog_provenance_never_guesses_chapter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, damage: str, status: str, title: str | None
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    database = tmp_path / "broken.db"
    async with api_client(database) as client:
        source, material = await setup_material(client)
        sid = (await create_segment(client, source, provenance(material))).json()["id"]
        other = (await client.post("/api/sources", json={"title": "不可见材料"})).json()["id"]
        with sqlite3.connect(database) as connection:
            if damage == "bundle":
                connection.execute("UPDATE materials SET compiled_bundle = ?", (b"broken",))
            elif damage == "version":
                connection.execute("UPDATE materials SET version_id = ?", ("0" * 26,))
            elif damage == "payload":
                connection.execute("UPDATE segment_material_provenance SET payload = '{}' ")
            elif damage == "cross_source":
                connection.execute("UPDATE materials SET source_id = ?", (other,))
            else:
                reference = provenance(material)
                reference["ranges"][0]["exact"] = "他"
                connection.execute(
                    "UPDATE segment_material_provenance SET payload = ?", (json.dumps(reference),)
                )
        page = (await client.get(f"/api/sources/{source}/catalog/segments")).json()
        assert page["total"] == 1 and page["items"][0]["id"] == sid
        assert page["items"][0]["provenance_summary"] == {
            "display": title,
            "title": title,
            "chapter_title": None,
            "chapter_percent": None,
            "status": status,
        }


@pytest.mark.asyncio
@pytest.mark.parametrize("deleted", ["source", "segment", "material", "rename", "product"])
async def test_catalog_provenance_rechecks_deletion_after_decode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, deleted: str
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    database = tmp_path / "race.db"
    async with api_client(database) as client:
        source, material = await setup_material(client)
        sid = (await create_segment(client, source, provenance(material))).json()["id"]
        entered, release = threading.Event(), threading.Event()
        original_decode = service.decode_epub

        def decode(data: bytes) -> CompiledBook:
            entered.set()
            assert release.wait(5)
            return original_decode(data)

        monkeypatch.setattr(service, "decode_epub", decode)
        pending = asyncio.create_task(client.get(f"/api/sources/{source}/catalog/segments"))
        try:
            assert await asyncio.to_thread(entered.wait, 5)
            with sqlite3.connect(database) as connection:
                if deleted == "rename":
                    connection.execute("UPDATE materials SET title = '并发改名'")
                elif deleted == "product":
                    connection.execute("UPDATE materials SET compiled_bundle = ?", (b"changed",))
                else:
                    table, identity = {
                        "source": ("sources", source),
                        "segment": ("segments", sid),
                        "material": ("materials", material["id"]),
                    }[deleted]
                    connection.execute(
                        f"UPDATE {table} SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?",
                        (identity,),
                    )
        finally:
            release.set()
        response = await pending
        if deleted == "source":
            assert response.status_code == 404
        elif deleted == "segment":
            assert response.json()["items"] == [] and response.json()["total"] == 0
        elif deleted == "rename":
            summary = response.json()["items"][0]["provenance_summary"]
            assert summary["status"] == "resolved"
            assert summary["display"] == "并发改名 · 同じ章 · 章内约 16%"
        else:
            summary = response.json()["items"][0]["provenance_summary"]
            assert summary["status"] == (
                "version_unavailable" if deleted == "product" else "material_deleted"
            )
            assert summary["title"] == "引用検証" and summary["chapter_title"] is None
