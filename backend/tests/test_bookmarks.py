"""Offline bookmark identity, bounded excerpts, independent state and lifecycle."""

import asyncio
import hashlib
import sqlite3
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from hypothesis import given
from hypothesis import strategies as st
from support_api import api_client
from support_epub import compiled

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
    assert location.excerpt == "…" + "前" * 40 + "😀𠮷が" + "後" * 75 + "…"
    assert len(location.excerpt) == 120
    tail = project_bookmark(book, PositionAnchor(**anchor(part_index=1, offset=300)))
    assert tail.excerpt == "…" + "後" * 43 and "外章" not in tail.excerpt
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
        assert first["position"]["offset"] == 100 and len(first["excerpt"]) == 120
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
                url, json={"request_id": str(uuid4()), "position": position, "allow_nearby": True}
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
    assert location.excerpt == "😀"
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


def text_book(text: str, *, split: int | None = None) -> CompiledBook:
    book = bookmark_book(b"")
    resource = book.resources[0].model_copy(
        update={"text": text, "text_sha256": hashlib.sha256(text.encode()).hexdigest()}
    )
    boundaries = [0, len(text)] if split is None else [0, split, len(text)]
    parts = [
        book.chapters[0]
        .parts[0]
        .model_copy(
            update={
                "start": start,
                "end": end,
                "html": '<ruby><span data-locator-leaf="0">'
                + text[start:end]
                + "</span><rt>読まないルビ</rt></ruby>",
            }
        )
        for start, end in zip(boundaries, boundaries[1:], strict=False)
    ]
    chapter = book.chapters[0].model_copy(update={"parts": parts})
    return book.model_copy(update={"resources": [resource], "chapters": [chapter]})


@pytest.mark.parametrize(
    ("text", "offset", "expected"),
    [
        ("前の文。現在の😀𠮷の文。次の文。", 7, "現在の😀𠮷の文。"),
        ("前の文。現在の文。", 9, "現在の文。"),
        ("前の文。現在の文。\n  ", 12, "現在の文。"),
        ("前の文。現在の文。", 8, "現在の文。"),
        ("「現在の文。」次の文。", 6, "「現在の文。」"),
        ("「現在の文。」次の文。", 7, "次の文。"),
        ("前の段落\n\n  現在の短段落\n次の段落", 6, "現在の短段落"),
        ("終わり\n\n", 5, "終わり"),
    ],
)
def test_excerpt_natural_sentence_boundaries_and_end_positions(
    text: str, offset: int, expected: str
) -> None:
    result = project_bookmark(text_book(text), PositionAnchor(**anchor(offset=offset)))
    assert result.excerpt == expected
    assert "読まないルビ" not in result.excerpt


def test_long_excerpt_keeps_position_uses_commas_and_total_budget() -> None:
    text = "前" * 90 + "、" + "😀𠮷当前位置" + "後" * 30 + "、" + "終" * 200 + "。"
    result = project_bookmark(text_book(text), PositionAnchor(**anchor(offset=93)))
    assert result.excerpt == "…😀𠮷当前位置" + "後" * 30 + "、…"
    long = project_bookmark(
        text_book("前" * 500 + "😀𠮷" + "後" * 500), PositionAnchor(**anchor(offset=500))
    )
    assert len(long.excerpt) == 120
    assert "😀𠮷" in long.excerpt and long.excerpt.startswith("…") and long.excerpt.endswith("…")
    # The same containing sentence crosses a part boundary without adding ruby.
    crossing = project_bookmark(
        text_book("前の文。これは跨ぐ文。次。", split=7),
        PositionAnchor(**anchor(part_index=1, offset=8)),
    )
    assert crossing.excerpt == "これは跨ぐ文。"
    exact = project_bookmark(text_book("前" * 120 + "。"), PositionAnchor(**anchor(offset=120)))
    assert len(exact.excerpt) <= 120 and exact.excerpt.endswith("。")


@pytest.mark.parametrize(
    ("changes", "expected"),
    [
        ({"offset": 100}, 0),
        ({"offset": 76}, 24),
        ({"offset": 75}, None),
        ({"offset": 0}, None),
        ({"part_index": 1, "offset": 103}, None),
        ({"chapter_id": "c2", "offset": 100}, None),
        ({"version_id": "other"}, None),
        ({"resource_id": "other"}, None),
        ({"kind": "image", "offset": None, "image_id": 0, "image_progress": 0}, None),
    ],
)
def test_nearby_text_uses_canonical_identity_not_repeated_excerpt(
    changes: dict[str, Any], expected: float | None
) -> None:
    from app.services.bookmark_positions import nearby_distance

    position = PositionAnchor(**anchor())
    location = project_bookmark(bookmark_book(b""), position)
    existing = PositionAnchor(**anchor(**changes))
    assert nearby_distance(position, existing, location) == expected


@pytest.mark.parametrize("boundary", ["。", "！", "？", "\n", "\r"])
def test_nearby_text_does_not_cross_sentence_or_line_boundary(boundary: str) -> None:
    from app.services.bookmark_positions import nearby_distance

    book = text_book("前" * 10 + boundary + "後" * 20)
    for first, second in ((9, 11), (11, 9)):
        position = PositionAnchor(**anchor(offset=first))
        assert (
            nearby_distance(
                position, PositionAnchor(**anchor(offset=second)), project_bookmark(book, position)
            )
            is None
        )


@pytest.mark.parametrize(
    ("changes", "nearby"),
    [
        ({"image_progress": 0.5}, True),
        ({"image_progress": 0.55}, True),
        ({"image_progress": 0.551}, False),
        ({"image_id": 2}, False),
        ({"chapter_id": "c2"}, False),
        ({"part_index": 0}, False),
    ],
)
def test_nearby_images_require_same_image_and_local_progress(
    changes: dict[str, Any], nearby: bool
) -> None:
    from app.services.bookmark_positions import nearby_distance

    values = anchor(part_index=1, kind="image", offset=None, image_id=9, image_progress=0.5)
    position = PositionAnchor(**values)
    existing = PositionAnchor(**{**values, **changes})
    assert (
        nearby_distance(position, existing, project_bookmark(bookmark_book(b""), position))
        is not None
    ) is nearby


@pytest.mark.asyncio
async def test_nearby_warning_force_frozen_retries_concurrency_and_deleted_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.services.reader_views import ReaderViews

    monkeypatch.setattr("app.services.materials.compile_epub_bytes", bookmark_book)
    database = tmp_path / "nearby.db"
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
        version = material["version_id"]
        position = anchor(version, offset=60)
        attempts = [{"request_id": str(uuid4()), "position": position} for _ in range(3)]
        responses = await asyncio.gather(*(client.post(url, json=attempt) for attempt in attempts))
        items = [response.json() for response in responses]
        saved = next(item for item in items if "id" in item)
        assert sum(item.get("kind") == "nearby" for item in items) == 2
        assert all(item.get("bookmark", saved)["id"] == saved["id"] for item in items)
        assert (await client.get(url, params={"version_id": version})).json()["total"] == 1
        force_payload = next(
            attempt
            for attempt, item in zip(attempts, items, strict=True)
            if item.get("kind") == "nearby"
        )
        forced = await asyncio.gather(
            *(client.post(url, json={**force_payload, "allow_nearby": True}) for _ in range(3))
        )
        forced_item = forced[0].json()
        assert forced_item["id"] != saved["id"] and all(
            response.json() == forced_item for response in forced
        )
        # allow_nearby is deliberately absent from the frozen successful request payload.
        assert (await client.post(url, json=force_payload)).json() == forced_item
        assert (
            await client.post(url, json={**force_payload, "position": anchor(version, offset=61)})
        ).status_code == 409

        async def should_not_project(*_args: Any, **_kwargs: Any) -> Any:
            raise AssertionError("saved request must win before excerpt projection")

        original = ReaderViews.bookmark_location
        monkeypatch.setattr(ReaderViews, "bookmark_location", should_not_project)
        assert (await client.post(url, json=force_payload)).json() == forced_item
        monkeypatch.setattr(ReaderViews, "bookmark_location", original)
        # New requests use nearest canonical offset rather than insertion order.
        closer = (
            await client.post(
                url,
                json={
                    "request_id": str(uuid4()),
                    "position": anchor(version, offset=80),
                    "allow_nearby": True,
                },
            )
        ).json()
        warning = (
            await client.post(
                url, json={"request_id": str(uuid4()), "position": anchor(version, offset=79)}
            )
        ).json()
        assert warning["kind"] == "nearby" and warning["bookmark"]["id"] == closer["id"]
        for item in (saved, forced_item, closer):
            assert (
                await client.delete(url + "/" + item["id"], params={"expected_revision": 0})
            ).status_code == 204
        fresh = (
            await client.post(url, json={"request_id": str(uuid4()), "position": position})
        ).json()
        assert "id" in fresh and fresh["id"] != saved["id"]
        assert (await client.post(url, json=force_payload)).status_code == 404
        with sqlite3.connect(database) as connection:
            assert connection.execute("SELECT COUNT(*) FROM material_bookmarks").fetchone() == (4,)


@pytest.mark.asyncio
async def test_progress_is_derived_for_legacy_rows_without_rewriting_excerpt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", bookmark_book)
    database = tmp_path / "bookmark-progress.db"
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
        version = material["version_id"]
        items: list[dict[str, Any]] = []
        for position, progress in [
            (anchor(version, part_index=1, offset=151), 151 / 303),
            (anchor(version, part_index=1, offset=303, at_chapter_end=True), 1),
            (
                anchor(
                    version,
                    chapter_id="c3",
                    kind="image",
                    offset=None,
                    image_id=0,
                    image_progress=0.5,
                ),
                None,
            ),
        ]:
            response = (
                await client.post(url, json={"request_id": str(uuid4()), "position": position})
            ).json()
            assert response["chapter_progress"] == progress
            items.append(response)
        with sqlite3.connect(database) as connection:
            connection.execute("UPDATE material_bookmarks SET excerpt='旧い保存済みの要約'")
        # A cold ReaderViews cache must derive progress for preexisting rows as well.
    async with api_client(database) as client:
        listing = (await client.get(url, params={"version_id": version})).json()
        assert [row["chapter_progress"] for row in listing["items"]] == [151 / 303, 1, None]
        assert all(row["excerpt"] == "旧い保存済みの要約" for row in listing["items"])
        fetched = (await client.get(url + "/" + items[0]["id"])).json()
        assert fetched["chapter_progress"] == 151 / 303
        edited = (
            await client.patch(
                url + "/" + items[0]["id"], json={"note": "旧資料も読む", "expected_revision": 0}
            )
        ).json()
        assert edited["chapter_progress"] == 151 / 303 and edited["excerpt"] == "旧い保存済みの要約"
        with sqlite3.connect(database) as connection:
            assert connection.execute(
                "SELECT DISTINCT excerpt FROM material_bookmarks"
            ).fetchall() == [("旧い保存済みの要約",)]


@given(
    before=st.text(alphabet="あいう、。\n\t😀「」", max_size=400),
    after=st.text(alphabet="かきく、。\n\t😀「」", max_size=400),
)
def test_excerpt_budget_never_drops_current_unicode_character(before: str, after: str) -> None:
    text = before + "𠮷" + after
    excerpt = project_bookmark(
        text_book(text), PositionAnchor(**anchor(offset=len(before)))
    ).excerpt
    assert 0 < len(excerpt) <= 120
    assert "𠮷" in excerpt


@pytest.mark.parametrize("offset", [3, 4, 5])
def test_excerpt_keeps_sentence_end_groups_with_closing_quotes(offset: int) -> None:
    text = "「本当！？」と答えた。"
    result = project_bookmark(text_book(text), PositionAnchor(**anchor(offset=offset)))
    assert result.excerpt == "「本当！？」"


@pytest.mark.parametrize("closer", ["」", "』", "）", ")", "]", "】", "〉", "》", "”", "’"])
def test_excerpt_closers_stay_attached_to_previous_sentence(closer: str) -> None:
    text = "先の文。" + closer + "後の文。"
    previous = project_bookmark(text_book(text), PositionAnchor(**anchor(offset=4)))
    following = project_bookmark(text_book(text), PositionAnchor(**anchor(offset=5)))
    assert previous.excerpt == "先の文。" + closer
    assert following.excerpt == "後の文。"


def test_excerpt_keeps_decimal_points_and_abbreviations_in_sentence() -> None:
    text = "前の文。Mr. Aの値は3.14です。次。"
    for offset in [7, 14, 15]:
        result = project_bookmark(text_book(text), PositionAnchor(**anchor(offset=offset)))
        assert result.excerpt == "Mr. Aの値は3.14です。"
