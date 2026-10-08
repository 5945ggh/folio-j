"""Offline material reading publication, re-use, failure and visibility contracts."""

import asyncio
import sqlite3
from pathlib import Path

import pytest
from test_materials import compiled
from test_source_segment import api_client

from app.nlp.tokenization import GeneratedReadings


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
        second = tokenization.generate(compiled(b""))
        monkeypatch.setattr(tokenization, "FORMAT_VERSION", "test-third")
        third = tokenization.generate(compiled(b""))
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
    asset = generate(book)
    part = book.chapters[0].parts[0].model_copy(update={"start": 2, "end": 3})
    chapter = book.chapters[0].model_copy(update={"parts": [part]})
    resource = chapter_resources(
        asset.payload, book.model_copy(update={"chapters": [chapter]}), "c1"
    )
    assert [token.surface for token in resource[0].tokens] == ["語"]
    assert resource[0].tokens[0].start == 2
