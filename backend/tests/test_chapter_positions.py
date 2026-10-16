"""Chapter history preserves independent anchors under the material CAS."""

import asyncio
import hashlib
import json
import sqlite3
from pathlib import Path

import pytest
from test_materials import compiled
from test_source_segment import api_client

from app.epub_schemas import CompiledBook
from app.material_schemas import PositionAnchor
from app.services.position_progress import chapter_progress


def two_chapters(data: bytes) -> CompiledBook:
    book = compiled(data)
    return book.model_copy(
        update={"chapters": [book.chapters[0], book.chapters[0].model_copy(update={"id": "c2"})]}
    )


@pytest.mark.asyncio
async def test_chapter_positions_share_atomic_material_revision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", two_chapters)
    database = tmp_path / "chapters.db"
    async with api_client(database) as client:
        source = (await client.post("/api/sources", json={"title": "本"})).json()["id"]
        material = (
            await client.post(
                f"/api/sources/{source}/materials",
                content=b"book",
                headers={"content-type": "application/epub+zip"},
            )
        ).json()["material"]
        url = f"/api/materials/{material['id']}"
        anchor = {
            "version_id": material["version_id"],
            "chapter_id": "c1",
            "part_index": 0,
            "resource_id": "r1",
            "kind": "text",
            "offset": 2,
            "expected_revision": 0,
        }
        assert (await client.get(url)).json()["chapter_positions"] == []
        assert (await client.put(url + "/reading-position", json=anchor)).json()[
            "progress"
        ] == pytest.approx(2 / 3)
        second = {**anchor, "chapter_id": "c2", "offset": 1, "expected_revision": 1}
        assert (await client.put(url + "/reading-position", json=second)).status_code == 200
        before = (await client.get(url)).json()
        assert [p["chapter_id"] for p in before["chapter_positions"]] == ["c1", "c2"]
        assert (await client.put(url + "/reading-position", json=anchor)).status_code == 409
        assert (await client.get(url)).json() == before
        concurrent = await asyncio.gather(
            *[
                client.put(
                    url + "/reading-position",
                    json={**anchor, "offset": offset, "expected_revision": 2},
                )
                for offset in (0, 3)
            ]
        )
        assert sorted(response.status_code for response in concurrent) == [200, 409]
        after = (await client.get(url)).json()
        assert len(after["chapter_positions"]) == 2
        assert after["chapter_positions"][0]["offset"] == after["reading_position"]["offset"]
        assert after["chapter_positions"][1] == before["chapter_positions"][1]
        assert after["reading_position"]["revision"] == 3
    async with api_client(database) as client:
        assert (await client.get(url)).json() == after


def test_progress_codepoints_parts_images_and_whitespace() -> None:
    book = compiled(b"")
    resource = book.resources[0].model_copy(update={"text": "𠮷日\n"})
    part = book.chapters[0].parts[0]
    # Same resource appearing twice is counted twice, not deduplicated.
    chapter = book.chapters[0].model_copy(
        update={"parts": [part, part.model_copy(update={"spine_index": 1})]}
    )
    book = book.model_copy(update={"resources": [resource], "chapters": [chapter]})
    anchor = PositionAnchor(
        version_id="v", chapter_id="c1", part_index=1, resource_id="r1", kind="text", offset=1
    )
    assert chapter_progress(book, anchor) == pytest.approx(4 / 6)
    image = anchor.model_copy(
        update={"kind": "image", "offset": None, "image_id": 0, "image_progress": 1}
    )
    assert chapter_progress(book, image) == 0.5
    assert chapter_progress(book, anchor.model_copy(update={"part_index": 0, "offset": 0})) == 0
    assert chapter_progress(book, anchor.model_copy(update={"offset": 3})) == 0.99
    image_only = book.model_copy(
        update={"resources": [resource.model_copy(update={"text": " \n\t"})]}
    )
    assert chapter_progress(image_only, image) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["text", "image"])
async def test_chapter_end_round_trip_revisit_and_conflict(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", two_chapters)
    database = tmp_path / "chapter-end.db"
    async with api_client(database) as client:
        source = (await client.post("/api/sources", json={"title": "本"})).json()["id"]
        material = (
            await client.post(
                f"/api/sources/{source}/materials",
                content=b"book",
                headers={"content-type": "application/epub+zip"},
            )
        ).json()["material"]
        url = f"/api/materials/{material['id']}"
        location = {"offset": 1} if kind == "text" else {"image_id": 0, "image_progress": 0.25}
        anchor = {
            "version_id": material["version_id"],
            "chapter_id": "c1",
            "part_index": 0,
            "resource_id": "r1",
            "kind": kind,
            **location,
        }
        ended = await client.put(
            url + "/reading-position",
            json={**anchor, "expected_revision": 0, "at_chapter_end": True},
        )
        assert ended.status_code == 200, ended.text
        saved = ended.json()
        assert saved["at_chapter_end"] is True
        assert saved["progress"] == 1
        assert all(saved[key] == value for key, value in location.items())
        assert (await client.get(url)).json()["reading_position"] == saved

        # A client without the new field still writes false and leaves c1's memory intact.
        second = await client.put(
            url + "/reading-position",
            json={**anchor, "chapter_id": "c2", "expected_revision": 1},
        )
        assert second.status_code == 200, second.text
        assert second.json()["at_chapter_end"] is False
        before = (await client.get(url)).json()
        assert before["chapter_positions"][0] == saved
        assert before["chapter_positions"][1] == second.json()
        stale = await client.put(
            url + "/reading-position",
            json={**anchor, "expected_revision": 1, "at_chapter_end": False},
        )
        assert stale.status_code == 409
        assert (await client.get(url)).json() == before

        revisited = await client.put(
            url + "/reading-position",
            json={**anchor, "expected_revision": 2, "at_chapter_end": False},
        )
        assert revisited.status_code == 200, revisited.text
        assert revisited.json()["at_chapter_end"] is False
        assert revisited.json()["progress"] == (pytest.approx(1 / 3) if kind == "text" else 0)
        assert all(revisited.json()[key] == value for key, value in location.items())
        after = (await client.get(url)).json()
        assert after["reading_position"] == revisited.json()
        assert after["chapter_positions"] == [revisited.json(), second.json()]
    async with api_client(database) as client:
        assert (await client.get(url)).json() == after
    with sqlite3.connect(database) as connection:
        assert (
            connection.execute(
                "SELECT status, revision FROM material_usage WHERE material_id=?",
                (material["id"],),
            ).fetchone()
            is None
        )


@pytest.mark.asyncio
async def test_legacy_position_payload_defaults_false_without_rewriting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    database = tmp_path / "legacy-position.db"
    async with api_client(database) as client:
        source = (await client.post("/api/sources", json={"title": "本"})).json()["id"]
        material = (
            await client.post(
                f"/api/sources/{source}/materials",
                content=b"book",
                headers={"content-type": "application/epub+zip"},
            )
        ).json()["material"]
        url = f"/api/materials/{material['id']}"
        legacy = {
            "version_id": material["version_id"],
            "chapter_id": "c1",
            "part_index": 0,
            "resource_id": "r1",
            "kind": "text",
            "offset": 3,
        }
        assert (
            await client.put(url + "/reading-position", json={**legacy, "expected_revision": 0})
        ).status_code == 200
    payload = json.dumps(legacy)
    with sqlite3.connect(database) as connection:
        for table in ("reading_positions", "chapter_reading_positions"):
            connection.execute(f"UPDATE {table} SET payload=?", (payload,))
    async with api_client(database) as client:
        response = (await client.get(url)).json()
        position = response["reading_position"]
        assert position["at_chapter_end"] is False
        assert position["offset"] == 3
        assert position["progress"] == 0.99
        assert response["chapter_positions"] == [position]
    with sqlite3.connect(database) as connection:
        for table in ("reading_positions", "chapter_reading_positions"):
            assert connection.execute(f"SELECT payload FROM {table}").fetchone() == (payload,)


@pytest.mark.parametrize("text", ["", " \n\t"])
def test_image_only_chapter_end_has_explicit_progress(text: str) -> None:
    book = compiled(b"")
    resource = book.resources[0].model_copy(update={"text": text})
    part = book.chapters[0].parts[0].model_copy(update={"end": len(text)})
    chapter = book.chapters[0].model_copy(update={"parts": [part]})
    book = book.model_copy(update={"resources": [resource], "chapters": [chapter]})
    anchor = PositionAnchor(
        version_id="v",
        chapter_id="c1",
        part_index=0,
        resource_id="r1",
        kind="image",
        image_id=0,
        image_progress=1,
    )
    assert chapter_progress(book, anchor) is None
    assert chapter_progress(book, anchor.model_copy(update={"at_chapter_end": True})) == 1


def test_text_rounding_and_trailing_image_require_chapter_end() -> None:
    book = compiled(b"")
    resource = book.resources[0].model_copy(update={"text": "日" * 1000})
    part = book.chapters[0].parts[0].model_copy(update={"end": 1000})
    chapter = book.chapters[0].model_copy(
        update={"parts": [part, part.model_copy(update={"start": 1000})]}
    )
    book = book.model_copy(update={"resources": [resource], "chapters": [chapter]})
    anchor = PositionAnchor(
        version_id="v", chapter_id="c1", part_index=0, resource_id="r1", kind="text", offset=999
    )
    assert chapter_progress(book, anchor) == 0.99
    image = anchor.model_copy(
        update={
            "part_index": 1,
            "kind": "image",
            "offset": None,
            "image_id": 0,
            "image_progress": 1,
        }
    )
    assert chapter_progress(book, image) == 0.99
    assert chapter_progress(book, image.model_copy(update={"at_chapter_end": True})) == 1


@pytest.mark.parametrize("changes", [{"chapter_id": "unknown"}, {"part_index": 1}])
def test_chapter_end_does_not_make_missing_chapter_or_part_valid(
    changes: dict[str, str | int],
) -> None:
    anchor = PositionAnchor(
        version_id="v", chapter_id="c1", part_index=0, resource_id="r1", kind="text", offset=1
    ).model_copy(update={"at_chapter_end": True, **changes})
    assert chapter_progress(compiled(b""), anchor) is None


def mixed_compiled(data: bytes) -> CompiledBook:
    book = compiled(data)
    markup = (
        '<span data-locator-leaf="7">前文&#x20bb7;&amp;</span>'
        '<img data-epub-image="3">'
        '<ruby><span data-locator-leaf="8">漢字</span><rt>かんじ</rt></ruby>'
        '<img data-epub-image="7">'
        '<span data-locator-leaf="9">後文</span>'
    )
    text = "章外の前置き文前文𠮷&漢字後文"
    prefix = "".join(
        f'<span data-locator-leaf="{index}">{character}</span>'
        for index, character in enumerate(text[:7])
    )
    resource = book.resources[0].model_copy(
        update={
            "text": text,
            "html": prefix + markup,
            "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
        }
    )
    part = (
        book.chapters[0]
        .parts[0]
        .model_copy(update={"start": 7, "end": 15, "html": markup, "leaf_start": 7, "leaf_end": 10})
    )
    chapter = book.chapters[0].model_copy(update={"parts": [part]})
    return book.model_copy(update={"resources": [resource], "chapters": [chapter]})


@pytest.mark.parametrize("image_id, expected", [(3, 0.5), (7, 0.75)])
@pytest.mark.parametrize("image_progress", [0.0, 0.25, 1.0])
def test_image_progress_uses_preceding_locator_text(
    image_id: int, expected: float, image_progress: float
) -> None:
    anchor = PositionAnchor(
        version_id="v",
        chapter_id="c1",
        part_index=0,
        resource_id="r1",
        kind="image",
        image_id=image_id,
        image_progress=image_progress,
    )
    assert chapter_progress(mixed_compiled(b""), anchor) == expected
    assert anchor.offset is None
    assert (
        chapter_progress(mixed_compiled(b""), anchor.model_copy(update={"at_chapter_end": True}))
        == 1
    )


def test_image_progress_counts_each_part_and_its_own_image_identity() -> None:
    book = mixed_compiled(b"")
    part = book.chapters[0].parts[0]
    second = part.model_copy(
        update={
            "start": 11,
            "end": 15,
            "html": (
                '<span data-locator-leaf="8">漢</span><img data-epub-image="3">'
                '<span data-locator-leaf="9">字後文</span>'
            ),
        }
    )
    chapter = book.chapters[0].model_copy(update={"parts": [part, second]})
    book = book.model_copy(update={"chapters": [chapter]})
    anchor = PositionAnchor(
        version_id="v",
        chapter_id="c1",
        part_index=0,
        resource_id="r1",
        kind="image",
        image_id=3,
        image_progress=0.5,
    )
    assert chapter_progress(book, anchor) == pytest.approx(4 / 12)
    assert chapter_progress(book, anchor.model_copy(update={"part_index": 1})) == 0.75


@pytest.mark.parametrize("image_id, expected", [(2, 1 / 3), (9, 2 / 3), (12, 0.99)])
def test_image_progress_normalizes_the_complete_raw_prefix(image_id: int, expected: float) -> None:
    book = compiled(b"")
    markup = (
        '<span data-locator-leaf="0">e</span><img data-epub-image="2">'
        '<span data-locator-leaf="1">&#x301;</span>'
        '<ruby><span data-locator-leaf="2">漢</span><rt>かん</rt><rp>(</rp></ruby>'
        '<img data-epub-image="9"><span data-locator-leaf="3">後</span>'
        '<img data-epub-image="12">'
    )
    resource = book.resources[0].model_copy(update={"text": "é漢後", "html": markup})
    part = book.chapters[0].parts[0].model_copy(update={"html": markup, "leaf_end": 4})
    chapter = book.chapters[0].model_copy(update={"parts": [part]})
    book = book.model_copy(update={"resources": [resource], "chapters": [chapter]})
    anchor = PositionAnchor(
        version_id="v",
        chapter_id="c1",
        part_index=0,
        resource_id="r1",
        kind="image",
        image_id=image_id,
        image_progress=0.5,
    )
    assert chapter_progress(book, anchor) == pytest.approx(expected)


@pytest.mark.asyncio
async def test_image_progress_put_get_and_restart_preserve_the_image_anchor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", mixed_compiled)
    database = tmp_path / "mixed-progress.db"
    async with api_client(database) as client:
        source = (await client.post("/api/sources", json={"title": "本"})).json()["id"]
        material = (
            await client.post(
                f"/api/sources/{source}/materials",
                content=b"book",
                headers={"content-type": "application/epub+zip"},
            )
        ).json()["material"]
        url = f"/api/materials/{material['id']}"
        anchor = {
            "version_id": material["version_id"],
            "chapter_id": "c1",
            "part_index": 0,
            "resource_id": "r1",
            "kind": "image",
            "image_id": 7,
            "image_progress": 0.3,
            "expected_revision": 0,
        }
        response = await client.put(url + "/reading-position", json=anchor)
        assert response.status_code == 200, response.text
        saved = response.json()
        assert saved["progress"] == 0.75
        assert saved["offset"] is None
        assert saved["image_id"] == 7
        assert saved["image_progress"] == 0.3
        assert saved["at_chapter_end"] is False
        after = (await client.get(url)).json()
        assert after["reading_position"] == saved
        assert after["chapter_positions"] == [saved]
    async with api_client(database) as client:
        assert (await client.get(url)).json() == after
