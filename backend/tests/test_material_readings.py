"""Offline material reading publication, re-use, failure and visibility contracts."""

import asyncio
import sqlite3
from collections.abc import Sequence
from pathlib import Path

import pytest
from test_materials import compiled
from test_source_segment import api_client

from app.nlp.contracts import TextResource
from app.nlp.tokenization import GeneratedReadings
from app.services.epub_readings import text_resources


@pytest.mark.asyncio
async def test_import_prepares_and_force_deduplicates_with_failure_preservation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    database = tmp_path / "readings.db"
    async with api_client(database) as client:
        source = (await client.post("/api/sources", json={"title": "棚"})).json()["id"]
        imported = await client.post(
            f"/api/sources/{source}/materials",
            content=b"book",
            headers={"content-type": "application/epub+zip"},
        )
        assert imported.status_code == 200, imported.text
        material = imported.json()["material"]
        url = f"/api/materials/{material['id']}/readings"
        body = {"version_id": material["version_id"]}
        first = await client.post(url + "/prepare", json=body)
        assert first.status_code == 200
        fetched = await client.get(url, params={**body, "chapter_id": "c1"})
        assert fetched.status_code == 200, fetched.text
        assert fetched.json()["generation_id"] == first.json()["generation_id"]
        assert fetched.json()["resources"][0]["tokens"][0]["surface"] == "日本"
        assert (await client.get(url, params={**body, "chapter_id": "missing"})).status_code == 404
        assert (
            await client.post(url + "/prepare", json={"version_id": "wrong"})
        ).status_code == 409
        forced = await asyncio.gather(
            *[client.post(url + "/prepare", json={**body, "force": True}) for _ in range(2)]
        )
        assert all(r.status_code == 200 and r.json() == first.json() for r in forced)

        def fail(_book: object) -> GeneratedReadings:
            raise ValueError("offline tokenizer failed")

        monkeypatch.setattr("app.services.readings.generate", fail)
        assert (await client.post(url + "/prepare", json=body)).status_code == 200
        failure = await client.post(url + "/prepare", json={**body, "force": True})
        assert failure.status_code == 503
        assert (await client.get(url, params={**body, "chapter_id": "c1"})).json() == fetched.json()
        new_import = await client.post(
            f"/api/sources/{source}/materials",
            content=b"new",
            headers={"content-type": "application/epub+zip"},
        )
        assert new_import.status_code == 503
        with sqlite3.connect(database) as connection:
            assert connection.execute("SELECT count(*) FROM materials").fetchone() == (1,)
            assert connection.execute(
                "SELECT count(*) FROM material_readings_generations"
            ).fetchone() == (1,)
            assert connection.execute("SELECT count(*) FROM runs").fetchone() == (0,)
        deleted = await client.request(
            "DELETE", f"/api/sources/{source}", json={"confirmation_title": "棚"}
        )
        assert deleted.status_code == 204
        assert (await client.post(url + "/prepare", json=body)).status_code == 404
        assert (await client.get(url, params={**body, "chapter_id": "c1"})).status_code == 404


@pytest.mark.asyncio
async def test_legacy_prepare_failure_is_retryable_and_reimport_repairs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    database = tmp_path / "legacy.db"
    async with api_client(database) as client:
        source = (await client.post("/api/sources", json={"title": "棚"})).json()["id"]
        upload_url = f"/api/sources/{source}/materials"
        imported = await client.post(
            upload_url, content=b"book", headers={"content-type": "application/epub+zip"}
        )
        material = imported.json()["material"]
        with sqlite3.connect(database) as connection:
            connection.execute("DELETE FROM material_readings_current")
            connection.execute("DELETE FROM material_readings_generations")
        url = f"/api/materials/{material['id']}/readings"
        body = {"version_id": material["version_id"]}
        assert (await client.get(url, params={**body, "chapter_id": "c1"})).status_code == 409
        with monkeypatch.context() as failed_generation:

            def fail(_book: object) -> GeneratedReadings:
                raise RuntimeError("temporary local failure")

            failed_generation.setattr("app.services.readings.generate", fail)
            assert (await client.post(url + "/prepare", json=body)).status_code == 503
            assert (await client.get(url, params={**body, "chapter_id": "c1"})).status_code == 409
        repaired = await client.post(
            upload_url, content=b"book", headers={"content-type": "application/epub+zip"}
        )
        assert repaired.status_code == 200 and repaired.json()["reused"]
        assert repaired.json()["material"]["version_id"] == material["version_id"]
        assert (await client.get(url, params={**body, "chapter_id": "c1"})).status_code == 200


@pytest.mark.asyncio
async def test_old_generation_reads_and_late_force_cannot_replace_newer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.nlp import tokenization

    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    database = tmp_path / "concurrent.db"
    async with api_client(database) as client:
        source = (await client.post("/api/sources", json={"title": "棚"})).json()["id"]
        imported = await client.post(
            f"/api/sources/{source}/materials",
            content=b"book",
            headers={"content-type": "application/epub+zip"},
        )
        material = imported.json()["material"]
        url = f"/api/materials/{material['id']}/readings"
        body = {"version_id": material["version_id"]}
        initial = (await client.post(url + "/prepare", json=body)).json()
        monkeypatch.setattr(tokenization, "FORMAT_VERSION", "test-second")
        second = tokenization.generate(text_resources(compiled(b"")))
        monkeypatch.setattr(tokenization, "FORMAT_VERSION", "test-third")
        third = tokenization.generate(text_resources(compiled(b"")))
        waiting, release = asyncio.Event(), asyncio.Event()
        calls = 0

        async def delayed(_book: object) -> GeneratedReadings:
            nonlocal calls
            calls += 1
            if calls == 1:
                waiting.set()
                await release.wait()
                return second
            return third

        monkeypatch.setattr("app.services.readings.build", delayed)
        late = asyncio.create_task(client.post(url + "/prepare", json={**body, "force": True}))
        await waiting.wait()
        newer = await client.post(url + "/prepare", json={**body, "force": True})
        assert newer.status_code == 200
        release.set()
        assert (await late).json() == newer.json()
        assert newer.json()["generation_id"] != initial["generation_id"]
        old = await client.get(
            url, params={**body, "chapter_id": "c1", "generation_id": initial["generation_id"]}
        )
        assert old.status_code == 200 and old.json()["generation_id"] == initial["generation_id"]
        absent = await client.get(url, params={**body, "chapter_id": "c1", "generation_id": "bad"})
        assert absent.status_code == 404
        with sqlite3.connect(database) as connection:
            assert connection.execute(
                "SELECT count(*) FROM material_readings_generations"
            ).fetchone() == (2,)


def test_chapter_response_filters_resource_ranges_without_changing_token_offsets() -> None:
    from app.nlp.tokenization import generate
    from app.services.readings import chapter_resources

    book = compiled(b"")
    asset = generate(text_resources(book))
    part = book.chapters[0].parts[0].model_copy(update={"start": 2, "end": 3})
    chapter = book.chapters[0].model_copy(update={"parts": [part]})
    resource = chapter_resources(
        asset.payload, book.model_copy(update={"chapters": [chapter]}), "c1"
    )
    assert [token.surface for token in resource[0].tokens] == ["語"]
    assert resource[0].tokens[0].start == 2


def test_repeated_spine_keeps_legacy_duplicate_chapter_readings() -> None:
    from app.nlp.tokenization import generate
    from app.services.readings import chapter_resources

    book = compiled(b"")
    repeated_part = book.chapters[0].parts[0].model_copy(update={"spine_index": 1})
    chapter = book.chapters[0].model_copy(update={"id": "c2", "parts": [repeated_part]})
    book = book.model_copy(
        update={
            "resources": [book.resources[0], book.resources[0]],
            "chapters": [*book.chapters, chapter],
        }
    )
    asset = generate(text_resources(book))
    assert asset.token_count == 4
    for chapter_id in ("c1", "c2"):
        projected = chapter_resources(asset.payload, book, chapter_id)
        # B1 records this existing duplication; a later fix must be explicit.
        assert len(projected) == 2
        assert projected[0] == projected[1]
        assert [token.surface for token in projected[0].tokens] == ["日本", "語"]


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["import", "rebuild"])
async def test_source_deletion_blocks_publication_after_generation(
    operation: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.nlp.tokenization import generate

    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    database = tmp_path / "deleted-while-generating.db"
    async with api_client(database) as client:
        source = (await client.post("/api/sources", json={"title": "棚"})).json()["id"]
        imported = await client.post(
            f"/api/sources/{source}/materials",
            content=b"book",
            headers={"content-type": "application/epub+zip"},
        )
        material = imported.json()["material"]
        started, release = asyncio.Event(), asyncio.Event()

        async def delayed(resources: Sequence[TextResource]) -> GeneratedReadings:
            started.set()
            await release.wait()
            return generate(resources)

        monkeypatch.setattr("app.services.readings.build", delayed)
        request = (
            client.post(
                f"/api/sources/{source}/materials",
                content=b"new-book",
                headers={"content-type": "application/epub+zip"},
            )
            if operation == "import"
            else client.post(
                f"/api/materials/{material['id']}/readings/prepare",
                json={"version_id": material["version_id"], "force": True},
            )
        )
        pending = asyncio.create_task(request)
        await asyncio.wait_for(started.wait(), timeout=5)
        try:
            deleted = await client.request(
                "DELETE", f"/api/sources/{source}", json={"confirmation_title": "棚"}
            )
            assert deleted.status_code == 204
        finally:
            release.set()
        assert (await pending).status_code == 404
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT count(*) FROM materials").fetchone() == (1,)
        assert connection.execute(
            "SELECT count(*) FROM material_readings_generations"
        ).fetchone() == (1,)
