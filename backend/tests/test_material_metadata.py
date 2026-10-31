"""Offline book details, atomic edits, immutable content and cover ownership."""

import asyncio
import base64
import sqlite3
import threading
import zlib
from pathlib import Path
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from support_api import api_client
from support_epub import compiled
from test_covers import PNG, cover_book, jpeg_fixture

from app.services.covers import MAX_COVER_BYTES, CoverExtraction, inspect_cover
from app.services.sources import begin_write


async def import_book(client: AsyncClient, raw: bytes = b"book") -> tuple[str, str]:
    source = (await client.post("/api/sources", json={"title": "来源"})).json()["id"]
    response = await client.post(
        f"/api/sources/{source}/materials",
        content=raw,
        headers={"content-type": "application/epub+zip"},
    )
    assert response.status_code == 200
    return source, "/api/materials/" + response.json()["material"]["id"]


def cover_input(image: bytes = PNG, media_type: str = "image/png") -> dict[str, str]:
    return {"media_type": media_type, "data_base64": base64.b64encode(image).decode()}


def immutable_snapshot(database: Path) -> dict[str, list[tuple[Any, ...]]]:
    with sqlite3.connect(database) as connection:
        result = {
            "materials": connection.execute(
                "SELECT id,source_id,source_sha256,version_id,product_sha256,contract_version,"
                "original_bytes,warnings,compiled_bundle,created_at FROM materials"
            ).fetchall()
        }
        for table in (
            "sources",
            "reading_positions",
            "chapter_reading_positions",
            "material_usage",
            "material_readings_generations",
            "material_readings_current",
        ):
            result[table] = connection.execute(f"SELECT * FROM {table}").fetchall()
        return result


@pytest.mark.asyncio
async def test_details_edits_reimport_and_restart_preserve_content(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    database = tmp_path / "metadata.db"
    async with api_client(database) as client:
        source, url = await import_book(client)
        material = (await client.get(url)).json()
        await client.put(
            url + "/reading-position",
            json={
                "version_id": material["version_id"],
                "chapter_id": "c1",
                "part_index": 0,
                "resource_id": "r1",
                "kind": "text",
                "offset": 2,
                "expected_revision": 0,
            },
        )
        await client.put(url + "/usage", json={"status": "completed", "expected_revision": 0})
        before = immutable_snapshot(database)

        def reject(*_args: object, **_kwargs: object) -> None:
            raise AssertionError("details and edits must not prepare readings")

        with monkeypatch.context() as patch:
            patch.setattr("app.services.readings.prepare", reject)
            details = (await client.get(url + "/details")).json()
            assert (details["original_title"], details["chapter_count"]) == ("本", 1)
            assert (details["metadata_revision"], details["custom_cover"]) == (0, False)
            assert (details["status"], details["usage_revision"], details["last_opened_at"]) == (
                "completed",
                1,
                None,
            )
            saved = await client.patch(
                url + "/metadata",
                json={
                    "title": "  か\u3099く  ",
                    "expected_revision": 0,
                    "cover_action": "replace",
                    "cover": cover_input(),
                },
            )
            assert saved.status_code == 200, saved.text
            assert saved.json()["title"] == "がく"
            assert saved.json()["custom_cover"] and saved.json()["metadata_revision"] == 1
            assert saved.json()["original_title"] == "本"
            assert saved.json()["cover_url"].endswith("?v=2&revision=1")
            assert (await client.get(url + "/cover")).content == PNG
            assert immutable_snapshot(database) == before
        reused = await client.post(
            f"/api/sources/{source}/materials",
            content=b"book",
            headers={"content-type": "application/epub+zip"},
        )
        assert reused.json()["reused"] and reused.json()["material"]["title"] == "がく"
        assert immutable_snapshot(database) == before
        item = (await client.get("/api/materials")).json()["items"][0]
        assert item["title"] == "がく" and item["cover_url"] == saved.json()["cover_url"]
        kept = await client.patch(url + "/metadata", json={"title": "保存", "expected_revision": 1})
        assert kept.json()["custom_cover"] and kept.json()["metadata_revision"] == 2
    async with api_client(database) as client:
        assert (await client.get(url + "/details")).json()["title"] == "保存"
        assert (await client.get(url + "/cover")).content == PNG


@pytest.mark.asyncio
async def test_parallel_atomic_edits_and_deleted_source_gate(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    async with api_client(tmp_path / "race.db") as client:
        source, url = await import_book(client)
        responses = await asyncio.gather(
            *[
                client.patch(
                    url + "/metadata",
                    json={
                        "title": title,
                        "expected_revision": 0,
                        "cover_action": "replace",
                        "cover": cover_input(image, media),
                    },
                )
                for title, image, media in [
                    ("PNG", PNG, "image/png"),
                    ("JPEG", jpeg_fixture(), "image/jpeg"),
                ]
            ]
        )
        assert sorted(r.status_code for r in responses) == [200, 409]
        winner = next(r.json() for r in responses if r.status_code == 200)
        actual = (await client.get(url + "/details")).json()
        assert actual == winner and actual["metadata_revision"] == 1
        assert (await client.get(url + "/cover")).content == (
            PNG if winner["title"] == "PNG" else jpeg_fixture()
        )
        assert (
            await client.patch(
                url + "/metadata",
                json={
                    "title": "陈旧",
                    "expected_revision": 0,
                    "cover_action": "reset",
                },
            )
        ).status_code == 409
        assert (await client.get(url + "/details")).json() == winner
        assert (await client.delete("/api/sources/" + source)).status_code == 204
        for path in ("/details", "/cover"):
            assert (await client.get(url + path)).status_code == 404
        assert (
            await client.patch(
                url + "/metadata",
                json={
                    "title": "删除后",
                    "expected_revision": 0,
                },
            )
        ).status_code == 404


@pytest.mark.asyncio
async def test_saved_response_keeps_its_cover_snapshot_after_a_later_edit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    async with api_client(tmp_path / "response-race.db") as client:
        _, url = await import_book(client)
        committed, release = asyncio.Event(), asyncio.Event()
        original_commit = AsyncSession.commit
        first_commit = True

        async def pause_after_first_commit(session: AsyncSession) -> None:
            nonlocal first_commit
            await original_commit(session)
            if first_commit:
                first_commit = False
                committed.set()
                await asyncio.wait_for(release.wait(), 5)

        monkeypatch.setattr(AsyncSession, "commit", pause_after_first_commit)
        pending = asyncio.create_task(
            client.patch(url + "/metadata", json={"title": "第一次", "expected_revision": 0})
        )
        try:
            await asyncio.wait_for(committed.wait(), 5)
            later = await client.patch(
                url + "/metadata",
                json={
                    "title": "第二次",
                    "expected_revision": 1,
                    "cover_action": "replace",
                    "cover": cover_input(),
                },
            )
            assert later.status_code == 200, later.text
            assert later.json()["custom_cover"] and later.json()["metadata_revision"] == 2
        finally:
            release.set()
            saved = await pending
        assert saved.status_code == 200, saved.text
        assert saved.json()["title"] == "第一次"
        assert saved.json()["metadata_revision"] == 1
        assert not saved.json()["custom_cover"]
        assert (await client.get(url + "/details")).json() == later.json()


def invalid_payloads() -> list[dict[str, object]]:
    huge = bytearray(PNG)
    huge[16:24] = (100_000).to_bytes(4, "big") * 2
    huge[29:33] = zlib.crc32(huge[12:29]).to_bytes(4, "big")
    return [
        {"title": " "},
        {"title": "本" * 301},
        {"expected_revision": -1},
        {"expected_revision": True},
        {"cover_action": "replace"},
        {"cover_action": "reset", "cover": cover_input()},
        {"cover_action": "keep", "cover": cover_input()},
        {"cover_action": "unknown"},
        {"source_id": "other"},
        *[
            {"cover_action": "replace", "cover": cover_input(image)}
            for image in (
                b"not an image",
                PNG[:-1],
                bytes(huge),
                PNG + b"x" * MAX_COVER_BYTES,
                PNG[:33] + b"\x00\x00\x00\x08acTL" + b"\x00" * 12 + PNG[33:],
            )
        ],
        {"cover_action": "replace", "cover": cover_input(PNG, "image/jpeg")},
        {"cover_action": "replace", "cover": cover_input(PNG, "image/gif")},
        *[
            {
                "cover_action": "replace",
                "cover": {
                    "media_type": "image/png",
                    "data_base64": value,
                },
            }
            for value in (
                "!bad",
                "data:image/png;base64,abc",
                base64.b64encode(PNG).decode() + "\n",
            )
        ],
    ]


@pytest.mark.asyncio
async def test_invalid_metadata_does_not_partially_save(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    async with api_client(tmp_path / "invalid.db") as client:
        _, url = await import_book(client)
        before = (await client.get(url + "/details")).json()
        for changes in invalid_payloads():
            response = await client.patch(
                url + "/metadata",
                json={
                    "title": "不会保存",
                    "expected_revision": 0,
                    **changes,
                },
            )
            assert response.status_code == 422, (changes.keys(), response.text)
            assert (await client.get(url + "/details")).json() == before


@pytest.mark.asyncio
@pytest.mark.parametrize("original", [b"book", cover_book()])
@pytest.mark.parametrize("remove_cache", [False, True])
async def test_custom_cover_survives_cache_upgrade_and_reset(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    original: bytes,
    remove_cache: bool,
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    database = tmp_path / "covers.db"
    async with api_client(database) as client:
        _, url = await import_book(client, original)
        material_id = url.rsplit("/", 1)[1]
        assert (await client.get(url + "/cover")).status_code in (200, 404)
        with sqlite3.connect(database) as connection:
            connection.execute(
                "UPDATE material_covers SET rule_version=1,media_type=NULL,data=NULL"
            )
        saved = await client.patch(
            url + "/metadata",
            json={
                "title": "自定义",
                "expected_revision": 0,
                "cover_action": "replace",
                "cover": cover_input(jpeg_fixture(), "image/jpeg"),
            },
        )
        assert saved.status_code == 200
        assert (await client.get(url + "/cover")).content == jpeg_fixture()
        with sqlite3.connect(database) as connection:
            assert connection.execute("SELECT rule_version FROM material_covers").fetchone() == (1,)
            if remove_cache:
                connection.execute(
                    "DELETE FROM material_covers WHERE material_id=?", (material_id,)
                )
        assert (await client.get(url + "/cover")).content == jpeg_fixture()
        reset = await client.patch(
            url + "/metadata",
            json={
                "title": "恢复",
                "expected_revision": 1,
                "cover_action": "reset",
            },
        )
        assert reset.status_code == 200 and not reset.json()["custom_cover"]
        cover = await client.get(url + "/cover")
        assert cover.status_code == (200 if original != b"book" else 404)
        if original != b"book":
            assert cover.content == PNG
        else:
            assert (await client.get(url + "/details")).json()["cover_url"] is None


@pytest.mark.asyncio
async def test_cover_rebuild_in_flight_cannot_hide_custom_override(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    entered, release = threading.Event(), threading.Event()

    def pause(raw: bytes) -> CoverExtraction:
        entered.set()
        assert release.wait(5), "test did not release cover extraction"
        return inspect_cover(raw)

    async with api_client(tmp_path / "rebuild.db") as client:
        _, url = await import_book(client, cover_book())
        monkeypatch.setattr("app.services.covers.inspect_cover", pause)
        pending = asyncio.create_task(client.get(url + "/cover"))
        try:
            assert await asyncio.to_thread(entered.wait, 5)
            saved = await client.patch(
                url + "/metadata",
                json={
                    "title": "自定义",
                    "expected_revision": 0,
                    "cover_action": "replace",
                    "cover": cover_input(jpeg_fixture(), "image/jpeg"),
                },
            )
            assert saved.status_code == 200
        finally:
            release.set()
        assert (await pending).content == jpeg_fixture()
        assert (await client.get(url + "/cover")).content == jpeg_fixture()


@pytest.mark.asyncio
async def test_source_deleted_before_edit_transaction_cannot_be_edited(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    database = tmp_path / "deleted.db"
    async with api_client(database) as client:
        source, url = await import_book(client)

        async def delete_before_lock(session: AsyncSession) -> None:
            assert (await client.delete("/api/sources/" + source)).status_code == 204
            await begin_write(session)

        monkeypatch.setattr("app.services.material_metadata.begin_write", delete_before_lock)
        rejected = await client.patch(
            url + "/metadata",
            json={
                "title": "不保存",
                "expected_revision": 0,
                "cover_action": "replace",
                "cover": cover_input(),
            },
        )
        assert rejected.status_code == 404
        with sqlite3.connect(database) as connection:
            assert connection.execute(
                "SELECT title,metadata_revision FROM materials"
            ).fetchone() == (
                "本",
                0,
            )
            assert connection.execute("SELECT * FROM material_custom_covers").fetchall() == []
