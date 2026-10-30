"""Offline bookmark identity, bounded excerpts, independent state and lifecycle."""

import asyncio
import hashlib
import sqlite3
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from test_materials import compiled
from test_source_segment import api_client

from app.bookmark_schemas import BookmarkUpdate
from app.epub_schemas import ChapterPart, CompiledBook, CompiledChapter
from app.material_schemas import PositionAnchor
from app.services.bookmark_positions import project_bookmark


def bookmark_book(_raw: bytes) -> CompiledBook:
    book = compiled(b"")
    text = "前" * 100 + "😀𠮷が" + "後" * 200 + "外章"
    resource = book.resources[0].model_copy(
        update={"text": text, "text_sha256": hashlib.sha256(text.encode()).hexdigest()}
    )

    def part(start: int, end: int, markup: str, spine: int = 0) -> ChapterPart:
        return ChapterPart(
            resource_id="r1",
            spine_index=spine,
            start=start,
            end=end,
            html=markup,
            leaf_start=0,
            leaf_end=1,
        )

    return book.model_copy(
        update={
            "resources": [resource],
            "chapters": [
                CompiledChapter(
                    id="c1",
                    title="第一章",
                    level=0,
                    parts=[
                        part(0, 103, '<span data-locator-leaf="0">' + text[:103] + "</span>"),
                        part(
                            103,
                            303,
                            '<img data-epub-image="9" alt="一">'
                            '<span data-locator-leaf="1">後後後</span>'
                            '<img data-epub-image="2" alt="二">'
                            '<span data-locator-leaf="2">' + text[106:303] + "</span>",
                        ),
                    ],
                ),
                CompiledChapter(id="c2", title="外章", level=0, parts=[part(303, 305, "外章")]),
                CompiledChapter(
                    id="c3",
                    title="絵だけ",
                    level=0,
                    parts=[part(0, 0, '<img data-epub-image="0" alt="挿絵 &amp; 図">', 1)],
                ),
                CompiledChapter(
                    id="c4",
                    title="無名の絵",
                    level=0,
                    parts=[part(0, 0, '<img data-epub-image="0">', 2)],
                ),
            ],
        }
    )


def anchor(version: str = "version", **changes: Any) -> dict[str, Any]:
    return {
        "version_id": version,
        "chapter_id": "c1",
        "part_index": 0,
        "resource_id": "r1",
        "kind": "text",
        "offset": 100,
        **changes,
    }


def test_canonical_excerpt_budget_unicode_parts_and_chapter_clip() -> None:
    book = bookmark_book(b"")
    location = project_bookmark(book, PositionAnchor(**anchor()))
    assert location.excerpt == "前" * 40 + "😀𠮷が" + "後" * 117
    assert len(location.excerpt) == 160
    tail = project_bookmark(book, PositionAnchor(**anchor(part_index=1, offset=300)))
    assert tail.excerpt == "後" * 43 and "外章" not in tail.excerpt
    for chapter, excerpt in (("c3", "挿絵 & 図"), ("c4", "")):
        image = PositionAnchor(
            **anchor(chapter_id=chapter, kind="image", offset=None, image_id=0, image_progress=0.2)
        )
        assert project_bookmark(book, image).excerpt == excerpt


@pytest.mark.asyncio
async def test_bookmark_api_frozen_retries_notes_sorting_and_deletion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", bookmark_book)
    database = tmp_path / "bookmarks.db"
    async with api_client(database) as client:
        source = (await client.post("/api/sources", json={"title": "本"})).json()["id"]
        imported = await client.post(
            f"/api/sources/{source}/materials",
            content=b"book",
            headers={"content-type": "application/epub+zip"},
        )
        material = imported.json()["material"]
        url = f"/api/materials/{material['id']}/bookmarks"
        version = material["version_id"]
        create = {"request_id": str(uuid4()), "position": anchor(version)}
        with sqlite3.connect(database) as connection:
            before = {
                table: connection.execute(f"SELECT * FROM {table}").fetchall()
                for table in (
                    "reading_positions",
                    "chapter_reading_positions",
                    "material_usage",
                    "runs",
                )
            }
        responses = await asyncio.gather(*(client.post(url, json=create) for _ in range(3)))
        assert [response.status_code for response in responses] == [200] * 3
        first = responses[0].json()
        assert all(response.json() == first for response in responses)
        item_url = url + "/" + first["id"]
        assert first["chapter_title"] == "第一章" and first["note"] == ""
        assert first["position"]["offset"] == 100 and len(first["excerpt"]) == 160
        assert (
            await client.post(url, json={**create, "position": anchor(version, offset=99)})
        ).status_code == 409
        edited = await client.patch(item_url, json={"note": "か\u3099𠮷", "expected_revision": 0})
        assert edited.status_code == 200, edited.text
        assert edited.json()["note"] == "が𠮷" and edited.json()["revision"] == 1
        assert (await client.post(url, json=create)).json() == edited.json()
        assert (
            await client.patch(item_url, json={"note": "lost", "expected_revision": 0})
        ).status_code == 409
        assert (await client.delete(item_url, params={"expected_revision": 0})).status_code == 409
        assert (await client.get(item_url)).json() == edited.json()
        assert (
            await client.patch(item_url, json={"note": "あ" * 5001, "expected_revision": 1})
        ).status_code == 422
        cleared = await client.patch(item_url, json={"note": "", "expected_revision": 1})
        assert cleared.json()["note"] == "" and cleared.json()["revision"] == 2

        positions = [
            anchor(version, part_index=1, offset=110),
            anchor(
                version, part_index=1, kind="image", offset=None, image_id=2, image_progress=0.5
            ),
            anchor(version, part_index=1, offset=104),
            anchor(
                version, part_index=1, kind="image", offset=None, image_id=9, image_progress=0.5
            ),
            anchor(version, chapter_id="c2", offset=303),
        ]
        added: list[dict[str, Any]] = []
        for position in positions:
            response = await client.post(
                url, json={"request_id": str(uuid4()), "position": position}
            )
            assert response.status_code == 200, response.text
            added.append(response.json())
        listing = (await client.get(url, params={"version_id": version})).json()
        assert listing["total"] == 6
        assert [row["id"] for row in listing["items"]] == [
            first["id"],
            added[3]["id"],
            added[2]["id"],
            added[1]["id"],
            added[0]["id"],
            added[4]["id"],
        ]
        page = (
            await client.get(url, params={"version_id": version, "offset": 2, "limit": 2})
        ).json()
        assert page["items"] == listing["items"][2:4] and page["total"] == 6
        for position in (
            anchor("stale"),
            anchor(version, offset=104),
            anchor(version, resource_id="other"),
            anchor(version, kind="image", offset=None, image_id=99, image_progress=0),
        ):
            assert (
                await client.post(url, json={"request_id": str(uuid4()), "position": position})
            ).status_code == 422
        assert (await client.get(url, params={"version_id": "stale"})).status_code == 409
        assert (await client.get(url)).status_code == 422
        assert (
            await client.get(url, params={"version_id": version, "limit": 101})
        ).status_code == 422
        assert (await client.delete(item_url, params={"expected_revision": 2})).status_code == 204
        assert (await client.get(item_url)).status_code == 404
        assert (await client.post(url, json=create)).status_code == 404
        with sqlite3.connect(database) as connection:
            for table, rows in before.items():
                assert connection.execute(f"SELECT * FROM {table}").fetchall() == rows
            assert (
                connection.execute(
                    "SELECT deleted_at,note,excerpt FROM material_bookmarks WHERE id=?",
                    (first["id"],),
                ).fetchone()[0]
                is not None
            )

        assert (await client.delete(f"/api/materials/{material['id']}")).status_code == 204
        for operation in (
            client.get(url, params={"version_id": version}),
            client.get(url + "/" + added[0]["id"]),
            client.post(url, json=create),
            client.patch(url + "/" + added[0]["id"], json={"note": "late", "expected_revision": 0}),
        ):
            assert (await operation).status_code == 404
        new_material = (
            await client.post(
                f"/api/sources/{source}/materials",
                content=b"book",
                headers={"content-type": "application/epub+zip"},
            )
        ).json()["material"]
        assert new_material["id"] != material["id"]
        new_url = f"/api/materials/{new_material['id']}/bookmarks"
        assert (
            await client.get(new_url, params={"version_id": new_material["version_id"]})
        ).json()["total"] == 0
        with sqlite3.connect(database) as connection:
            assert connection.execute("SELECT COUNT(*) FROM material_bookmarks").fetchone() == (6,)


@pytest.mark.asyncio
@pytest.mark.parametrize("delete_parent", ["material", "source"])
async def test_visibility_rechecked_after_projection_without_holding_write_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, delete_parent: str
) -> None:
    from app.services.bookmark_positions import BookmarkLocation
    from app.services.reader_views import MaterialIdentity, ReaderViews

    monkeypatch.setattr("app.services.materials.compile_epub_bytes", bookmark_book)
    database = tmp_path / "bookmarks-race.db"
    async with api_client(database) as client:
        source = (await client.post("/api/sources", json={"title": "本"})).json()["id"]
        material = (
            await client.post(
                f"/api/sources/{source}/materials",
                content=b"book",
                headers={"content-type": "application/epub+zip"},
            )
        ).json()["material"]
        url = f"/api/materials/{material['id']}/bookmarks"
        position = anchor(material["version_id"])
        saved = (
            await client.post(url, json={"request_id": str(uuid4()), "position": position})
        ).json()
        saved_url = url + "/" + saved["id"]
        await client.patch(saved_url, json={"note": "保留する感想", "expected_revision": 0})
        projected = asyncio.Event()
        resume = asyncio.Event()
        original = ReaderViews.bookmark_location

        async def wait_location(
            self: ReaderViews, material_id: str, position: PositionAnchor
        ) -> tuple[MaterialIdentity, BookmarkLocation]:
            result = await original(self, material_id, position)
            projected.set()
            await resume.wait()
            return result

        monkeypatch.setattr(ReaderViews, "bookmark_location", wait_location)
        creating = asyncio.create_task(
            client.post(url, json={"request_id": str(uuid4()), "position": position})
        )
        try:
            await asyncio.wait_for(projected.wait(), 5)
            parent_url = (
                f"/api/materials/{material['id']}"
                if delete_parent == "material"
                else f"/api/sources/{source}"
            )
            deleted = await asyncio.wait_for(client.delete(parent_url), 5)
            assert deleted.status_code == 204
        finally:
            resume.set()
        assert (await creating).status_code == 404
        assert (await client.get(saved_url)).status_code == 404
        assert (
            await client.get(url, params={"version_id": material["version_id"]})
        ).status_code == 404
        assert (await client.delete(saved_url, params={"expected_revision": 1})).status_code == 404
        with sqlite3.connect(database) as connection:
            assert connection.execute(
                "SELECT note,excerpt,deleted_at FROM material_bookmarks"
            ).fetchall() == [("保留する感想", saved["excerpt"], None)]
    async with api_client(database) as client:
        assert (await client.get(saved_url)).status_code == 404


def test_note_budget_applies_to_normalized_codepoints_and_rejects_non_text() -> None:
    from pydantic import ValidationError

    assert BookmarkUpdate(note="か\u3099" * 5000, expected_revision=0).note == "が" * 5000
    for note in ("𠮷" * 4999 + "\u0344", 12, None):
        with pytest.raises(ValidationError):
            BookmarkUpdate.model_validate({"note": note, "expected_revision": 0})


def test_excerpt_uses_canonical_text_and_compacts_unicode_whitespace() -> None:
    book = compiled(b"")
    text = "😀  \n\t𠮷\r\n　日本語"
    resource = book.resources[0].model_copy(update={"text": text})
    part = (
        book.chapters[0]
        .parts[0]
        .model_copy(
            update={
                "end": len(text),
                "html": '<ruby>日本語<rt>にほんご</rt></ruby><div data-epub-image="7"></div>',
            }
        )
    )
    chapter = book.chapters[0].model_copy(update={"parts": [part]})
    book = book.model_copy(update={"resources": [resource], "chapters": [chapter]})
    location = project_bookmark(book, PositionAnchor(**anchor(offset=0)))
    assert location.excerpt == "😀 𠮷 日本語"
    from fastapi import HTTPException

    with pytest.raises(HTTPException, match="图片位置无法精确确认"):
        project_bookmark(
            book,
            PositionAnchor(
                **anchor(
                    kind="image",
                    offset=None,
                    image_id=7,
                    image_progress=0,
                )
            ),
        )
