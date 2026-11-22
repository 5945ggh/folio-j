"""The original lookup span supplies lexical evidence with or without a dictionary."""

from pathlib import Path
from typing import cast

import pytest
from support_api import chat_client
from support_dictionary_lookup import MemoryStore, entry
from support_dictionary_store import archive, record

from app.dictionary_schemas import DictionaryLookupRequest, DictionaryTokenHint
from app.services.dictionary_lookup import (
    TOKEN_CONTEXT,
    _analyze,  # pyright: ignore[reportPrivateUsage]
    lookup,
)
from app.services.dictionary_store import DictionaryStore


@pytest.mark.asyncio
async def test_empty_dictionary_lookup_and_snapshot_identity(tmp_path: Path) -> None:
    async with chat_client(tmp_path / "app.db") as (client, _):
        request = {"text": "🧪食べました。", "position": 4, "expected_dictionary_id": None}
        empty = await client.post("/api/dictionary/lookup", json=request)
        assert empty.status_code == 200, empty.text
        assert empty.json()["matches"] == []
        chain, token = empty.json()["analyses"]
        assert (chain["start"], chain["end"], chain["surface"], chain["reading"]) == (
            1,
            6,
            "食べました",
            "タベマシタ",
        )
        assert [part["surface"] for part in chain["inflection"]] == ["食べ", "まし", "た"]
        assert token["surface"] == "まし"

        imported = await client.post("/api/dictionary/import", content=archive([record("食べる")]))
        assert imported.status_code == 200, imported.text
        stale = await client.post("/api/dictionary/lookup", json=request)
        assert stale.status_code == 409
        request.pop("expected_dictionary_id")
        current = await client.post("/api/dictionary/lookup", json=request)
        assert current.status_code == 200, current.text
        assert [match["term"] for match in current.json()["matches"]] == ["食べる"]
        assert current.json()["analyses"] == [chain]


@pytest.mark.asyncio
@pytest.mark.parametrize("auto_expand", [True, False])
async def test_missing_terms_only_offer_covering_token_and_real_chain(auto_expand: bool) -> None:
    store = cast(DictionaryStore, MemoryStore([entry("雨")]))
    result = await lookup(
        store,
        DictionaryLookupRequest(text="ご飯食べました。", position=5, auto_expand=auto_expand),
    )
    assert result.matches == []
    assert [(item.start, item.end, item.surface) for item in result.analyses] == (
        [(2, 7, "食べました"), (4, 6, "まし")] if auto_expand else []
    )


@pytest.mark.asyncio
async def test_short_dictionary_hit_takes_priority_over_longer_known_source_token() -> None:
    empty_store = cast(DictionaryStore, MemoryStore([entry("雨")]))
    request = DictionaryLookupRequest(text="今日は", position=0)
    assert [item.surface for item in (await lookup(empty_store, request)).analyses] == ["今日"]

    store = cast(DictionaryStore, MemoryStore([entry("今")]))
    result = await lookup(store, request)
    assert [match.term for match in result.matches] == ["今"]
    (analysis,) = result.analyses
    assert (analysis.start, analysis.end, analysis.surface) == (0, 1, "今")
    assert analysis.reading == ""
    assert analysis.components == analysis.inflection == []


@pytest.mark.asyncio
async def test_same_range_uses_original_reading_once_across_homophones() -> None:
    store = cast(
        DictionaryStore, MemoryStore([entry("見", reading="み", id=2), entry("身", reading="み")])
    )
    result = await lookup(
        store, DictionaryLookupRequest(text="みました", selection_start=0, selection_end=1)
    )
    assert {match.term for match in result.matches} == {"身", "見"}
    (analysis,) = result.analyses
    (component,) = analysis.components
    assert (analysis.reading, component.dictionary_form, component.pos[0]) == ("ミ", "みる", "動詞")


@pytest.mark.asyncio
async def test_partial_selection_keeps_bounds_and_only_records_complete_components() -> None:
    store = cast(DictionaryStore, MemoryStore([]))
    result = await lookup(
        store,
        DictionaryLookupRequest(text="食べました。", selection_start=1, selection_end=5),
    )
    (analysis,) = result.analyses
    assert (analysis.start, analysis.end, analysis.surface) == (1, 5, "べました")
    assert analysis.reading == ""
    assert [(part.start, part.end, part.surface) for part in analysis.components] == [
        (2, 4, "まし"),
        (4, 5, "た"),
    ]
    assert analysis.inflection == []


@pytest.mark.asyncio
async def test_oov_does_not_publish_guessed_reading_or_lemma() -> None:
    store = cast(DictionaryStore, MemoryStore([]))
    result = await lookup(store, DictionaryLookupRequest(text="龘と出会った。", position=0))
    (analysis,) = result.analyses
    (component,) = analysis.components
    assert (analysis.surface, analysis.reading) == ("龘", "")
    assert component.is_oov
    assert component.reading == component.dictionary_form == ""
    assert analysis.inflection == []


@pytest.mark.asyncio
async def test_long_selection_keeps_exact_surface_without_analyzing_clipped_final_token() -> None:
    store = cast(DictionaryStore, MemoryStore([]))
    text = "猫。" * (TOKEN_CONTEXT // 2 - 1) + "山田さん。"
    result = await lookup(store, DictionaryLookupRequest(text=text))
    (analysis,) = result.analyses
    assert (analysis.start, analysis.end, analysis.surface) == (0, len(text), text)
    assert analysis.reading == ""
    assert all(part.end < TOKEN_CONTEXT for part in analysis.components)


@pytest.mark.asyncio
async def test_complete_hints_preserve_components_through_explicit_selection() -> None:
    store = cast(DictionaryStore, MemoryStore([]))
    text = "図書館の資料を見た。" * 6
    request = DictionaryLookupRequest(text=text)
    result = await lookup(store, request)
    request.tokens = [DictionaryTokenHint(**token.model_dump()) for token in _analyze(text)]

    with_hints = await lookup(store, request)
    assert with_hints == result
    assert result.analyses[0].components[-1].end == len(text)
