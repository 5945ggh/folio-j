"""Offline managed EPUB atomicity, ownership and position contracts."""

import asyncio
import base64
import hashlib
import random
import sqlite3
import threading
import zlib
from pathlib import Path
from typing import Any
from uuid import uuid4
from zipfile import ZipFile

import pytest
from test_source_segment import api_client

from app.epub_schemas import ChapterPart, CompiledBook, CompiledChapter, CompiledResource
from app.epub_storage import decode as decode_epub
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
    # A valid RGB PNG exceeds the deflate window, making pooled image storage useful.
    def png_chunk(kind: bytes, data: bytes) -> bytes:
        return (
            len(data).to_bytes(4, "big") + kind + data + zlib.crc32(kind + data).to_bytes(4, "big")
        )

    pixels = random.Random(20261025).randbytes(160 * 160 * 3)
    scanlines = b"".join(
        b"\x00" + pixels[start : start + 480] for start in range(0, len(pixels), 480)
    )
    image_bytes = (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", (160).to_bytes(4, "big") * 2 + b"\x08\x02\x00\x00\x00")
        + png_chunk(b"IDAT", zlib.compress(scanlines))
        + png_chunk(b"IEND", b"")
    )
    fixture = tmp_path / "large-image.epub"
    with ZipFile(FIXTURE) as source, ZipFile(fixture, "w") as target:
        for item in source.infolist():
            target.writestr(
                item,
                image_bytes if item.filename == "OEBPS/images/pixel.png" else source.read(item),
            )
    database = tmp_path / "real.db"
    async with api_client(database) as client:
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
        with sqlite3.connect(database) as connection:
            stored = connection.execute(
                "SELECT compiled_bundle FROM materials WHERE id=?", (material["id"],)
            ).fetchone()
        assert stored is not None
        logical = decode_epub(stored[0])
        assert len(stored[0]) < len(zlib.compress(logical.model_dump_json().encode()))
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

        # Images survive the stored bundle and keep their chapter/position identities.
        material_url = f"/api/materials/{material['id']}"
        version = {"version_id": material["version_id"]}
        illustrations = await client.get(material_url + "/illustrations", params=version)
        assert illustrations.status_code == 200, illustrations.text
        assert illustrations.json()["total"] == 1
        image = illustrations.json()["items"][0]
        image_part = payload["parts"][image["part_index"]]
        assert image["chapter_id"] == payload["id"]
        assert image["resource_id"] == image_part["resource_id"]
        content = await client.get(image["content_url"])
        assert content.status_code == 200
        with ZipFile(fixture) as archive:
            assert content.content == archive.read("OEBPS/images/pixel.png")
        assert (
            f"data:image/png;base64,{base64.b64encode(content.content).decode()}"
            in (image_part["html"])
        )
        assert f'data-epub-image="{image["image_id"]}"' in image_part["html"]
        position = await client.put(
            material_url + "/reading-position",
            json={
                "expected_revision": 0,
                **version,
                "chapter_id": image["chapter_id"],
                "part_index": image["part_index"],
                "resource_id": image["resource_id"],
                "kind": "image",
                "image_id": image["image_id"],
                "image_progress": 0.5,
            },
        )
        assert position.status_code == 200, position.text
        assert position.json()["image_id"] == image["image_id"]
        statistics = await client.get(material_url + "/statistics", params=version)
        assert statistics.status_code == 200, statistics.text
        assert statistics.json()["text"]["character_count"] > 0
        assert statistics.json()["lexical"]["counted_token_count"] > 0
        assert statistics.json()["version_id"] == material["version_id"]
        segment = await client.post(
            f"/api/sources/{sid}/segments",
            json={
                "request_id": str(uuid4()),
                "material_provenance": {
                    "contract_version": "1",
                    "material_id": material["id"],
                    **version,
                    "ranges": [
                        {
                            "resource_id": match["resource_id"],
                            "spine_index": match["spine_index"],
                            "start": match["start"],
                            "end": match["end"],
                            "exact": query,
                            "text_sha256": resource["text_sha256"],
                        }
                    ],
                },
            },
        )
        assert segment.status_code == 201, segment.text
        assert segment.json()["text"] == query
        resolved = await client.get(f"/api/segments/{segment.json()['id']}/material-provenance")
        assert resolved.status_code == 200, resolved.text
        assert resolved.json()["status"] == "resolved"
        assert resolved.json()["chapter_id"] == match["chapter_id"]
        markers = await client.get(
            material_url + f"/chapters/{match['chapter_id']}/segments", params=version
        )
        assert markers.status_code == 200, markers.text
        assert [item["segment_id"] for item in markers.json()["items"]] == [segment.json()["id"]]

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
