"""Chapter history preserves independent anchors under the material CAS."""

import asyncio
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
    assert chapter_progress(book, anchor.model_copy(update={"offset": 3})) == 1
    image_only = book.model_copy(
        update={"resources": [resource.model_copy(update={"text": " \n\t"})]}
    )
    assert chapter_progress(image_only, image) is None
