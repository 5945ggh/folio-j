"""Offline managed EPUB atomicity, ownership and position contracts."""

import asyncio
import hashlib
import sqlite3
import threading
from pathlib import Path
from typing import Any

import pytest
from test_source_segment import api_client

from app.epub_schemas import ChapterPart, CompiledBook, CompiledChapter, CompiledResource
from app.services.epub import EpubError

FIXTURE = (
    Path(__file__).resolve().parents[2] / "prototypes/epub-reading/fixtures/synthetic-reading.epub"
)


def compiled(_data: bytes) -> CompiledBook:
    return CompiledBook(
        contract="test-v1",
        title="本",
        warnings=[],
        product_sha256="a" * 64,
        resources=[
            CompiledResource(
                id="r1",
                href="text.xhtml",
                title="章",
                text="日本語",
                html='<p>日本語</p><img data-epub-image="0">',
                css="",
                html_attributes={},
                body_attributes={},
                text_sha256=hashlib.sha256("日本語".encode()).hexdigest(),
            )
        ],
        chapters=[
            CompiledChapter(
                id="c1",
                title="章",
                level=0,
                parts=[
                    ChapterPart(
                        resource_id="r1",
                        spine_index=0,
                        start=0,
                        end=3,
                        html='<p>日本語</p><img data-epub-image="0">',
                        leaf_start=0,
                        leaf_end=1,
                    )
                ],
            )
        ],
    )


@pytest.mark.asyncio
async def test_material_identity_positions_delete_and_restart(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    database = tmp_path / "materials.db"
    async with api_client(database) as client:
        source = (await client.post("/api/sources", json={"title": "本棚"})).json()["id"]
        other = (await client.post("/api/sources", json={"title": "別"})).json()["id"]

        async def upload(sid: str, raw: bytes = b"book") -> Any:
            result = await client.post(
                f"/api/sources/{sid}/materials",
                content=raw,
                headers={"content-type": "application/epub+zip"},
            )
            assert result.status_code == 200, result.text
            return result.json()

        first = await upload(source)
        material = first["material"]
        assert not first["reused"]
        duplicate = await upload(source)
        assert duplicate["reused"] and duplicate["material"]["version_id"] == material["version_id"]
        assert (await upload(other))["material"]["id"] != material["id"]
        assert (await upload(source, b"different"))["material"]["id"] != material["id"]
        compiling = threading.Barrier(2)

        def compile_parallel(data: bytes) -> CompiledBook:
            compiling.wait(timeout=5)
            return compiled(data)

        with monkeypatch.context() as concurrent:
            concurrent.setattr("app.services.materials.compile_epub_bytes", compile_parallel)
            parallel = await asyncio.gather(
                upload(source, b"parallel"), upload(source, b"parallel")
            )
        assert parallel[0]["material"]["id"] == parallel[1]["material"]["id"]
        assert sorted(result["reused"] for result in parallel) == [False, True]
        url = f"/api/materials/{material['id']}"
        chapter = (await client.get(url + "/chapters/c1")).json()
        assert chapter["resources"][0]["text"] == "日本語"
        anchor = {
            "expected_revision": 0,
            "version_id": material["version_id"],
            "chapter_id": "c1",
            "part_index": 0,
            "resource_id": "r1",
            "kind": "text",
            "offset": 2,
        }
        for changes in (
            {"version_id": "wrong"},
            {"resource_id": "wrong"},
            {"offset": 4},
            {"chapter_id": "wrong"},
            {"part_index": 1},
        ):
            assert (
                await client.put(url + "/reading-position", json={**anchor, **changes})
            ).status_code == 422
        saved = await client.put(url + "/reading-position", json=anchor)
        assert saved.status_code == 200, saved.text
        assert saved.json()["revision"] == 1
        assert (await client.put(url + "/reading-position", json=anchor)).status_code == 409
        image = {
            **anchor,
            "expected_revision": 1,
            "kind": "image",
            "offset": None,
            "image_id": 0,
            "image_progress": 0.5,
        }
        assert (
            await client.put(url + "/reading-position", json={**image, "image_id": 99})
        ).status_code == 422
        assert (await client.put(url + "/reading-position", json=image)).status_code == 200
    async with api_client(database) as client:
        assert (await client.get(url)).json()["reading_position"]["image_progress"] == 0.5
        assert (await client.get(f"/api/sources/{source}/delete-impact")).json()[
            "material_count"
        ] == 3
        assert (await client.delete(f"/api/sources/{source}")).status_code == 204
        assert (await client.get(url)).status_code == 404
        assert (await client.get(url + "/chapters/c1")).status_code == 404
        assert (await client.get(f"/api/sources/{source}/materials")).status_code == 404
    with sqlite3.connect(database) as connection:
        assert connection.execute(
            "SELECT original_bytes,source_sha256 FROM materials WHERE id=?", (material["id"],)
        ).fetchone() == (b"book", hashlib.sha256(b"book").hexdigest())


@pytest.mark.asyncio
async def test_failed_import_has_no_residue(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fail(_data: bytes) -> CompiledBook:
        raise EpubError("无效文件")

    monkeypatch.setattr("app.services.materials.compile_epub_bytes", fail)
    database = tmp_path / "failure.db"
    async with api_client(database) as client:
        sid = (await client.post("/api/sources", json={"title": "本"})).json()["id"]
        result = await client.post(
            f"/api/sources/{sid}/materials",
            content=b"bad",
            headers={"content-type": "application/epub+zip"},
        )
        assert result.status_code == 422
        assert (await client.get(f"/api/sources/{sid}/materials")).json() == []
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT count(*) FROM materials").fetchone() == (0,)
        assert connection.execute("SELECT count(*) FROM reading_positions").fetchone() == (0,)


@pytest.mark.asyncio
async def test_late_import_is_rejected_after_source_deletion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    started = threading.Event()
    release = threading.Event()

    def delayed(data: bytes) -> CompiledBook:
        started.set()
        assert release.wait(5)
        return compiled(data)

    monkeypatch.setattr("app.services.materials.compile_epub_bytes", delayed)
    database = tmp_path / "late.db"
    async with api_client(database) as client:
        sid = (await client.post("/api/sources", json={"title": "本"})).json()["id"]
        task = asyncio.create_task(
            client.post(
                f"/api/sources/{sid}/materials",
                content=b"book",
                headers={"content-type": "application/epub+zip"},
            )
        )
        assert await asyncio.to_thread(started.wait, 5)
        try:
            assert (await client.delete(f"/api/sources/{sid}")).status_code == 204
        finally:
            release.set()
        assert (await task).status_code == 404
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT count(*) FROM materials").fetchone() == (0,)


@pytest.mark.asyncio
async def test_real_epub_upload_and_bounded_request(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture = FIXTURE
    async with api_client(tmp_path / "real.db") as client:
        sid = (await client.post("/api/sources", json={"title": "本"})).json()["id"]
        url = f"/api/sources/{sid}/materials"
        invalid = await client.post(
            url, content=b"not zip", headers={"content-type": "application/epub+zip"}
        )
        assert invalid.status_code == 422
        uploaded = await client.post(
            url, content=fixture.read_bytes(), headers={"content-type": "application/epub+zip"}
        )
        assert uploaded.status_code == 200, uploaded.text
        material = uploaded.json()["material"]
        assert material["chapters"]
        chapter = await client.get(
            f"/api/materials/{material['id']}/chapters/{material['chapters'][0]['id']}"
        )
        assert chapter.status_code == 200
        payload = chapter.json()
        # The fixture has an NFC composition across inline elements and a non-BMP character.
        query = "がと𠮷"
        found = await client.get(
            f"/api/materials/{material['id']}/search",
            params={"version_id": material["version_id"], "q": query},
        )
        assert found.status_code == 200, found.text
        assert found.json()["total"] == 1
        match = found.json()["items"][0]
        assert match["chapter_id"] == payload["id"]
        resource = next(r for r in payload["resources"] if r["id"] == match["resource_id"])
        assert resource["text"][match["start"] : match["end"]] == match["match"] == query
        assert match["end"] - match["start"] == 3
        part = payload["parts"][match["part_index"]]
        assert part["resource_id"] == match["resource_id"]
        assert part["spine_index"] == match["spine_index"]
        assert part["start"] <= match["start"] < match["end"] <= part["end"]

        def unexpected(_data: bytes) -> CompiledBook:
            raise AssertionError("Duplicate uploads must reuse the published bundle")

        monkeypatch.setattr("app.services.materials.compile_epub_bytes", unexpected)
        assert (
            await client.post(
                url, content=fixture.read_bytes(), headers={"content-type": "application/epub+zip"}
            )
        ).json()["reused"]
        monkeypatch.setattr("app.services.materials.MAX_UPLOAD_BYTES", 3)
        assert (
            await client.post(
                url, content=b"1234", headers={"content-type": "application/epub+zip"}
            )
        ).status_code == 413
        assert (
            await client.post(
                url, content=b"1", headers={"content-type": "application/octet-stream"}
            )
        ).status_code == 415
