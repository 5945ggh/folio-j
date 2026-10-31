"""Real SQLite races while immutable book facts are decoded outside the write lock."""

import asyncio
import sqlite3
import threading
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path

import pytest
from support_api import api_client
from support_epub import compiled
from test_covers import PNG, jpeg_fixture
from test_material_metadata import cover_input, import_book

from app.epub_schemas import CompiledBook
from app.material_models import Material
from app.services import material_metadata


@contextmanager
def paused_first_decode(
    monkeypatch: pytest.MonkeyPatch,
) -> Generator[tuple[threading.Event, threading.Event], None, None]:
    entered, release = threading.Event(), threading.Event()
    original = material_metadata.bundle

    def pause(material: Material) -> CompiledBook:
        if not entered.is_set():
            entered.set()
            assert release.wait(10), "test did not release bundle decoding"
        return original(material)

    monkeypatch.setattr(material_metadata, "bundle", pause)
    try:
        yield entered, release
    finally:
        release.set()


@pytest.mark.asyncio
async def test_metadata_decode_allows_other_writes_and_returns_current_details(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    async with api_client(tmp_path / "decode-lock.db") as client:
        source, url = await import_book(client)
        other = (await client.post("/api/sources", json={"title": "另一来源"})).json()["id"]
        with paused_first_decode(monkeypatch) as (entered, release):
            pending = asyncio.create_task(
                client.patch(
                    url + "/metadata",
                    json={
                        "title": "保存",
                        "expected_revision": 0,
                        "cover_action": "replace",
                        "cover": cover_input(),
                    },
                )
            )
            try:
                assert await asyncio.to_thread(entered.wait, 5)
                unrelated = await asyncio.wait_for(
                    client.patch("/api/sources/" + other, json={"note": "不等待解码"}), 2
                )
                assert unrelated.status_code == 200, unrelated.text
                assert unrelated.json()["note"] == "不等待解码"
                renamed = await client.patch("/api/sources/" + source, json={"title": "新来源名"})
                assert renamed.status_code == 200, renamed.text
                usage = await client.put(
                    url + "/usage", json={"status": "completed", "expected_revision": 0}
                )
                assert usage.status_code == 200, usage.text
            finally:
                release.set()
                saved = await pending
        assert saved.status_code == 200, saved.text
        details = saved.json()
        assert (details["source_title"], details["status"], details["usage_revision"]) == (
            "新来源名",
            "completed",
            1,
        )
        assert (details["original_title"], details["chapter_count"]) == ("本", 1)
        assert (details["title"], details["metadata_revision"], details["custom_cover"]) == (
            "保存",
            1,
            True,
        )
        assert (await client.get(url + "/details")).json() == details
        assert (await client.get(url + "/cover")).content == PNG


@pytest.mark.asyncio
async def test_metadata_revision_is_rechecked_after_decode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    async with api_client(tmp_path / "decode-revision.db") as client:
        _, url = await import_book(client)
        with paused_first_decode(monkeypatch) as (entered, release):
            pending = asyncio.create_task(
                client.patch(
                    url + "/metadata",
                    json={
                        "title": "迟到",
                        "expected_revision": 0,
                        "cover_action": "replace",
                        "cover": cover_input(),
                    },
                )
            )
            try:
                assert await asyncio.to_thread(entered.wait, 5)
                winner = await asyncio.wait_for(
                    client.patch(
                        url + "/metadata",
                        json={
                            "title": "最新",
                            "expected_revision": 0,
                            "cover_action": "replace",
                            "cover": cover_input(jpeg_fixture(), "image/jpeg"),
                        },
                    ),
                    2,
                )
                assert winner.status_code == 200, winner.text
            finally:
                release.set()
                stale = await pending
        assert stale.status_code == 409, stale.text
        assert (await client.get(url + "/details")).json() == winner.json()
        assert (await client.get(url + "/cover")).content == jpeg_fixture()


@pytest.mark.asyncio
@pytest.mark.parametrize("deleted", ["source", "material"])
async def test_metadata_visibility_is_rechecked_after_decode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, deleted: str
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    database = tmp_path / "decode-deletion.db"
    async with api_client(database) as client:
        source, url = await import_book(client)
        with paused_first_decode(monkeypatch) as (entered, release):
            pending = asyncio.create_task(
                client.patch(
                    url + "/metadata",
                    json={
                        "title": "迟到",
                        "expected_revision": 0,
                        "cover_action": "replace",
                        "cover": cover_input(),
                    },
                )
            )
            try:
                assert await asyncio.to_thread(entered.wait, 5)
                removed = await asyncio.wait_for(
                    client.delete("/api/sources/" + source if deleted == "source" else url), 2
                )
                assert removed.status_code == 204, removed.text
            finally:
                release.set()
                rejected = await pending
        assert rejected.status_code == 404, rejected.text
        with sqlite3.connect(database) as connection:
            assert connection.execute(
                "SELECT title,metadata_revision FROM materials"
            ).fetchone() == (
                "本",
                0,
            )
            assert connection.execute("SELECT * FROM material_custom_covers").fetchall() == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field", ["source_id", "source_sha256", "version_id", "product_sha256", "contract_version"]
)
async def test_metadata_rejects_changed_immutable_identity_after_decode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, field: str
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    database = tmp_path / "decode-version.db"
    async with api_client(database) as client:
        _, url = await import_book(client)
        other = (await client.post("/api/sources", json={"title": "另一来源"})).json()["id"]

        def replace_identity() -> None:
            # No product operation mutates immutable versions. Simulate a future replacement
            # or repair and verify that facts decoded from the old version cannot be published.
            with sqlite3.connect(database, timeout=1) as connection:
                connection.execute("PRAGMA foreign_keys=ON")
                connection.execute(
                    f"UPDATE materials SET {field}=? WHERE id=?",
                    (other if field == "source_id" else "changed", url.rsplit("/", 1)[1]),
                )

        with paused_first_decode(monkeypatch) as (entered, release):
            pending = asyncio.create_task(
                client.patch(
                    url + "/metadata",
                    json={
                        "title": "迟到",
                        "expected_revision": 0,
                        "cover_action": "replace",
                        "cover": cover_input(),
                    },
                )
            )
            try:
                assert await asyncio.to_thread(entered.wait, 5)
                await asyncio.to_thread(replace_identity)
            finally:
                release.set()
                rejected = await pending
        assert rejected.status_code == 409, rejected.text
        with sqlite3.connect(database) as connection:
            assert connection.execute(
                "SELECT title,metadata_revision FROM materials"
            ).fetchone() == (
                "本",
                0,
            )
            assert connection.execute("SELECT * FROM material_custom_covers").fetchall() == []
