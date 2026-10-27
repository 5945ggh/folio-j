"""Offline full-book queries, codepoint ranges, image ownership and immutable state."""

import base64
import hashlib
import sqlite3
from pathlib import Path

import pytest
from test_materials import compiled
from test_source_segment import api_client

from app.epub_schemas import ChapterPart, CompiledBook, CompiledChapter

PNG = b"\x89PNG\r\n\x1a\n" + b"synthetic-image"


def query_book(_raw: bytes) -> CompiledBook:
    book = compiled(b"")
    text = "😀𠮷é" + "あ" * 65 + "[.*]Ａ"
    encoded = base64.b64encode(PNG).decode()
    image = f'<img data-epub-image="0" alt="絵 &amp; 図" src="data:image/png;base64,{encoded}">'
    bad = '<img data-epub-image="1" src="data:image/png;base64,YmFk">'
    foreign = '<img data-epub-image="2" src="https://example.com/no.png">'
    svg = '<img data-epub-image="3" src="data:image/svg+xml;base64,PHN2Zz4=">'
    resource = book.resources[0].model_copy(
        update={
            "text": text,
            "html": image,
            "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
        }
    )

    def part(spine: int, start: int, end: int, html: str) -> ChapterPart:
        return ChapterPart(
            resource_id="r1",
            spine_index=spine,
            start=start,
            end=end,
            html=html,
            leaf_start=0,
            leaf_end=1,
        )

    return book.model_copy(
        update={
            "resources": [resource],
            "chapters": [
                CompiledChapter(
                    id="c1",
                    title="最初",
                    level=0,
                    parts=[
                        part(0, 0, 4, image),
                        part(0, 4, len(text), bad + foreign + svg),
                    ],
                ),
                CompiledChapter(
                    id="c2", title="繰返", level=0, parts=[part(1, 0, len(text), image)]
                ),
                CompiledChapter(id="c3", title="画像のみ", level=0, parts=[part(2, 0, 0, image)]),
            ],
        }
    )


@pytest.mark.asyncio
async def test_full_search_images_gates_and_read_only(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", query_book)
    database = tmp_path / "queries.db"
    async with api_client(database) as client:
        sid = (await client.post("/api/sources", json={"title": "本"})).json()["id"]
        uploaded = await client.post(
            f"/api/sources/{sid}/materials",
            content=b"immutable",
            headers={"content-type": "application/epub+zip"},
        )
        material = uploaded.json()["material"]
        url = f"/api/materials/{material['id']}"
        version = {"version_id": material["version_id"]}
        with sqlite3.connect(database) as connection:
            original = connection.execute("SELECT * FROM materials").fetchall()

        result = await client.get(url + "/search", params={**version, "q": "ああ"})
        assert result.status_code == 200, result.text
        payload = result.json()
        assert payload["total"] == 128 and len(payload["items"]) == 40
        assert payload["items"][0]["start"] == 3
        assert payload["items"][0]["end"] == 5
        assert payload["items"][0]["part_index"] == 0  # Crosses a contiguous part boundary.
        assert payload["items"][1]["part_index"] == 1
        tail = (
            await client.get(
                url + "/search",
                params={
                    **version,
                    "q": "ああ",
                    "offset": 64,
                    "limit": 100,
                },
            )
        ).json()
        assert tail["total"] == 128 and len(tail["items"]) == 64
        assert tail["items"][0]["spine_index"] == 1
        assert tail["items"][0]["chapter_id"] == "c2"
        for query, expected_start in (("😀𠮷", 0), (" e\u0301 ", 2), ("[.*]", 68), ("Ａ", 72)):
            found = (await client.get(url + "/search", params={**version, "q": query})).json()
            assert found["total"] == 2
            assert found["items"][0]["start"] == expected_start
        assert (await client.get(url + "/search", params={**version, "q": "A"})).json()[
            "total"
        ] == 0
        for query in (" ", "missing"):
            assert (await client.get(url + "/search", params={**version, "q": query})).json()[
                "total"
            ] == 0
        for params in ({"q": "あ" * 161}, {"offset": -1}, {"limit": 101}, {"limit": 0}):
            assert (
                await client.get(url + "/search", params={**version, **params})
            ).status_code == 422
        assert (await client.get(url + "/search")).status_code == 422

        images = (await client.get(url + "/illustrations", params=version)).json()
        assert images["total"] == 4
        assert [item["ordinal"] for item in images["items"]] == [0, 1, 2, 3]
        assert images["items"][0]["alt"] == "絵 & 図"
        assert images["items"][3]["chapter_id"] == "c3"
        located = await client.get(
            url + "/illustrations/locate",
            params={**version, "chapter_id": "c2", "part_index": 0, "image_id": 0},
        )
        assert located.status_code == 200
        assert located.json()["total"] == 4
        assert located.json()["items"] == [images["items"][2]]
        assert (
            await client.get(
                url + "/illustrations/locate",
                params={**version, "chapter_id": "c1", "part_index": 0, "image_id": 99},
            )
        ).status_code == 404
        assert (
            await client.get(
                url + "/illustrations/locate",
                params={"version_id": "wrong", "chapter_id": "c1", "part_index": 0, "image_id": 0},
            )
        ).status_code == 409
        page = (
            await client.get(
                url + "/illustrations",
                params={
                    **version,
                    "offset": 2,
                    "limit": 1,
                },
            )
        ).json()
        assert page["total"] == 4 and page["items"][0]["spine_index"] == 1
        for ordinal in (0, 2, 3):
            content = await client.get(images["items"][ordinal]["content_url"])
            assert content.status_code == 200 and content.content == PNG
            assert content.headers["content-type"] == "image/png"
            assert content.headers["x-content-type-options"] == "nosniff"
            assert content.headers["cache-control"] == "private, no-store"
        assert (await client.get(images["items"][1]["content_url"])).status_code == 422
        assert (
            await client.get(url + "/illustrations/4/content", params=version)
        ).status_code == 404
        assert (
            await client.get(url + "/illustrations/-1/content", params=version)
        ).status_code == 422
        for route in ("/search", "/illustrations", "/illustrations/0/content"):
            assert (
                await client.get(url + route, params={"version_id": "wrong"})
            ).status_code == 409
            assert (
                await client.get("/api/materials/missing" + route, params=version)
            ).status_code == 404
        with sqlite3.connect(database) as connection:
            assert connection.execute("SELECT * FROM materials").fetchall() == original
            assert connection.execute("SELECT count(*) FROM reading_positions").fetchone() == (0,)
            assert connection.execute("SELECT count(*) FROM runs").fetchone() == (0,)
            assert connection.execute("SELECT count(*) FROM material_usage").fetchone() == (0,)
        assert (await client.delete(f"/api/sources/{sid}")).status_code == 204
        assert (
            await client.get(
                url + "/illustrations/locate",
                params={**version, "chapter_id": "c1", "part_index": 0, "image_id": 0},
            )
        ).status_code == 404
        for route in ("/search", "/illustrations", "/illustrations/0/content"):
            assert (await client.get(url + route, params=version)).status_code == 404


def test_query_scope_and_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.epub_storage import encode
    from app.material_models import Material
    from app.services.reader_queries import scan_illustrations, scan_search

    book = query_book(b"")
    text = book.resources[0].text
    original = book.chapters[0]
    split = len(text) - 2
    chapters = [
        original.model_copy(
            update={
                "parts": [
                    original.parts[0].model_copy(
                        update={
                            "start": 0,
                            "end": split,
                            "html": "<p>text</p>",
                        }
                    )
                ]
            }
        ),
        original.model_copy(
            update={
                "id": "end",
                "parts": [
                    original.parts[1].model_copy(
                        update={
                            "start": split,
                            "end": len(text),
                            "html": "<p>text</p>",
                        }
                    )
                ],
            }
        ),
    ]
    material = Material(
        id="m",
        version_id="v",
        compiled_bundle=encode(book.model_copy(update={"chapters": chapters})),
    )
    assert scan_search(material, ".*]", 0, 40).total == 0  # Cannot cross a chapter boundary.
    assert scan_illustrations(material, 0, 40).total == 0

    def unexpected(_material: Material) -> CompiledBook:
        raise AssertionError("Whitespace search must not decompress or scan")

    monkeypatch.setattr("app.services.reader_queries.bundle", unexpected)
    assert scan_search(material, "", 0, 40).total == 0


@pytest.mark.asyncio
async def test_search_cpu_is_off_event_loop(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import threading

    from app.material_models import Material
    from app.material_schemas import MaterialSearchResponse
    from app.services.reader_queries import scan_search

    main_thread = threading.get_ident()
    thread_ids: list[int] = []

    def observed(material: Material, query: str, offset: int, limit: int) -> MaterialSearchResponse:
        thread_ids.append(threading.get_ident())
        return scan_search(material, query, offset, limit)

    monkeypatch.setattr("app.services.materials.compile_epub_bytes", query_book)
    monkeypatch.setattr("app.services.reader_queries.scan_search", observed)
    async with api_client(tmp_path / "thread.db") as client:
        sid = (await client.post("/api/sources", json={"title": "本"})).json()["id"]
        uploaded = (
            await client.post(
                f"/api/sources/{sid}/materials",
                content=b"book",
                headers={"content-type": "application/epub+zip"},
            )
        ).json()["material"]
        result = await client.get(
            f"/api/materials/{uploaded['id']}/search",
            params={
                "version_id": uploaded["version_id"],
                "q": "あ",
            },
        )
        assert result.status_code == 200
        assert thread_ids and all(thread != main_thread for thread in thread_ids)


@pytest.mark.asyncio
async def test_image_pagination_budget_and_mime(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_data = {
        "image/png": PNG,
        "image/jpeg": b"\xff\xd8\xff\xe0synthetic",
        "image/gif": b"GIF89asynthetic",
        "image/webp": b"RIFFxxxxWEBPsynthetic",
    }

    def many_images(_raw: bytes) -> CompiledBook:
        book = query_book(b"")
        html = "".join(
            f'<img data-epub-image="{index}" src="data:{mime};base64,'
            f'{base64.b64encode(data).decode()}">'
            for index, (mime, data) in enumerate(list(image_data.items()) * 12)
        )
        part = book.chapters[0].parts[0].model_copy(update={"html": html})
        chapter = book.chapters[0].model_copy(update={"parts": [part]})
        return book.model_copy(update={"chapters": [chapter]})

    monkeypatch.setattr("app.services.materials.compile_epub_bytes", many_images)
    async with api_client(tmp_path / "images.db") as client:
        sid = (await client.post("/api/sources", json={"title": "本"})).json()["id"]
        material = (
            await client.post(
                f"/api/sources/{sid}/materials",
                content=b"book",
                headers={"content-type": "application/epub+zip"},
            )
        ).json()["material"]
        url = f"/api/materials/{material['id']}/illustrations"
        version = {"version_id": material["version_id"]}
        first = (await client.get(url, params=version)).json()
        assert first["total"] == 48 and len(first["items"]) == 40
        last = (await client.get(url, params={**version, "offset": 40})).json()
        assert last["total"] == 48 and len(last["items"]) == 8
        assert last["items"][0]["ordinal"] == 40
        for ordinal, (mime, data) in enumerate(image_data.items()):
            response = await client.get(f"{url}/{ordinal}/content", params=version)
            assert response.content == data and response.headers["content-type"] == mime
        monkeypatch.setattr("app.services.reader_queries.MAX_PRODUCT_BYTES", 1)
        assert (await client.get(f"{url}/0/content", params=version)).status_code == 413
