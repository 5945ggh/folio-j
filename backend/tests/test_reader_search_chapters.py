"""Original text chapter filters apply before complete counts and pagination."""

from pathlib import Path

import pytest
from support_api import api_client
from support_reader_books import query_book
from support_segment_provenance import setup_material


@pytest.mark.asyncio
async def test_chapter_selection_filters_before_counting_and_paging(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", query_book)
    async with api_client(tmp_path / "chapters.db") as client:
        _source, material = await setup_material(client)
        url = f"/api/materials/{material['id']}/search"
        version = {"version_id": material["version_id"]}
        filtered = await client.get(
            url,
            params={**version, "q": "ああ", "chapter_ids": ["c2"], "offset": 62, "limit": 5},
        )
        assert filtered.status_code == 200, filtered.text
        page = filtered.json()
        assert page["total"] == 64 and len(page["items"]) == 2
        assert all(item["chapter_id"] == "c2" for item in page["items"])
        assert [item["start"] for item in page["items"]] == [65, 66]
        combined = await client.get(
            url,
            params={
                **version,
                "q": "ああ",
                "chapter_ids": ["c2", "c1", "c2"],
                "offset": 63,
                "limit": 2,
            },
        )
        assert combined.status_code == 200, combined.text
        assert combined.json()["total"] == 128
        assert [item["chapter_id"] for item in combined.json()["items"]] == ["c1", "c2"]
        assert [item["start"] for item in combined.json()["items"]] == [66, 3]
        images_only = await client.get(url, params={**version, "q": "あ", "chapter_ids": ["c3"]})
        assert images_only.status_code == 200 and images_only.json()["total"] == 0
        for query in ("あ", ""):
            unknown = await client.get(
                url, params={**version, "q": query, "chapter_ids": ["absent"]}
            )
            assert unknown.status_code == 422, unknown.text
