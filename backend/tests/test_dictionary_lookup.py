"""Synthetic lexical fixtures protect recall, actual spans and complete sequence cards."""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import cast

import pytest

from app.dictionary_schemas import DictionaryLookupRequest, DictionaryNode, DictionaryTokenHint
from app.nlp.contracts import MaterialReadingToken
from app.services import dictionary_lookup
from app.services.dictionary_lookup import (
    MAX_WORD_LENGTH,
    _candidates,  # pyright: ignore[reportPrivateUsage]
    _key,  # pyright: ignore[reportPrivateUsage]
    lookup,
)
from app.services.dictionary_store import DictionaryEntry, DictionaryStore


def entry(
    term: str,
    *,
    id: int = 1,
    reading: str = "",
    sequence: int | None = None,
    definition: str = "释义",
    rules: str = "",
    dictionary_id: str = "test-v1",
) -> DictionaryEntry:
    return DictionaryEntry(
        id=id,
        dictionary_id=dictionary_id,
        term=term,
        reading=reading,
        rules=rules,
        sequence=sequence,
        definitions=(DictionaryNode(text=definition),),
        order=id,
        definition_tags="",
        term_tags="",
        score=0,
    )


def token(
    text: str,
    start: int,
    end: int,
    *,
    lemma: str | None = None,
    reading: str = "",
    pos: list[str] | None = None,
) -> DictionaryTokenHint:
    return DictionaryTokenHint(
        start=start,
        end=end,
        surface=text[start:end],
        reading=reading,
        dictionary_form=lemma or text[start:end],
        normalized_form=lemma or text[start:end],
        pos=pos or ["名詞", "普通名詞", "一般", "*", "*", "*"],
        is_oov=False,
    )


class MemoryStore:
    def __init__(self, entries: list[DictionaryEntry]) -> None:
        self.entries = entries
        self.find_calls = 0
        self.sequence_calls = 0
        self.query_keys: list[str] = []

    @asynccontextmanager
    async def snapshot(self) -> AsyncGenerator["MemoryStore"]:
        yield self

    async def find_terms(self, keys: list[str]) -> list[DictionaryEntry]:
        self.find_calls += 1
        self.query_keys = keys
        normalized = {_key(k) for k in keys}
        return [e for e in self.entries if {_key(e.term), _key(e.reading)} & normalized]

    async def load_definitions(self, entries: list[DictionaryEntry]) -> list[DictionaryEntry]:
        return entries

    async def get_sequences(self, keys: list[tuple[str, int]]) -> list[DictionaryEntry]:
        self.sequence_calls += 1
        return [e for e in self.entries if (e.dictionary_id, e.sequence) in keys]


async def query(store: MemoryStore, request: DictionaryLookupRequest) -> list[tuple[str, int, int]]:
    result = await lookup(cast(DictionaryStore, store), request)
    assert all(request.text[m.start : m.end] == m.surface for m in result.matches)
    return [(m.term, m.start, m.end) for m in result.matches]


@pytest.mark.asyncio
async def test_middle_click_keeps_compound_and_in_token_short_candidate() -> None:
    text = "彼は国際連合大学で学ぶ。"
    store = MemoryStore([entry("大学", id=1), entry("国際連合大学", id=2), entry("連合", id=3)])
    request = DictionaryLookupRequest(
        text=text,
        position=5,
        tokens=[token(text, 2, 4), token(text, 4, 6), token(text, 6, 8)],
    )
    assert await query(store, request) == [("国際連合大学", 2, 8), ("連合", 4, 6)]
    # A character within a large token still finds the short dictionary entry.
    request = DictionaryLookupRequest(text=text, position=7, tokens=[token(text, 2, 8)])
    assert await query(store, request) == [("国際連合大学", 2, 8), ("大学", 6, 8)]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text,term",
    [
        ("食べました", "食べる"),
        ("行った", "行く"),
        ("高くなかった", "高い"),
        ("申し込んだ", "申し込む"),
        ("おいしくない", "おいしい"),
        ("食べている", "食べる"),
        ("勉強していた", "勉強する"),
        ("食べられなかった", "食べる"),
        ("飲んじゃった", "飲む"),
    ],
)
async def test_no_token_inflections_cover_actual_surface(text: str, term: str) -> None:
    store = MemoryStore([entry(term)])
    for position in range(len(text)):
        matches = await query(store, DictionaryLookupRequest(text=text, position=position))
        assert matches and matches[0] == (term, 0, len(text))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text,term,expected",
    [
        (
            "空いていない",
            "空く",
            [
                ("空い", "空く", "continuative", "イ音便"),
                ("て", "て", None, None),
                ("い", "いる", "irrealis", None),
                ("ない", "ない", None, None),
            ],
        ),
        (
            "食べられなかった",
            "食べる",
            [
                ("食べ", "食べる", "irrealis", None),
                ("られ", "られる", "irrealis", None),
                ("なかっ", "ない", "continuative", "促音便"),
                ("た", "た", None, None),
            ],
        ),
        (
            "読んでいる",
            "読む",
            [
                ("読ん", "読む", "continuative", "撥音便"),
                ("で", "で", None, None),
                ("いる", "いる", None, None),
            ],
        ),
        (
            "高くなかった",
            "高い",
            [
                ("高く", "高い", "continuative", None),
                ("なかっ", "ない", "continuative", "促音便"),
                ("た", "た", None, None),
            ],
        ),
        (
            "食べさせられた",
            "食べる",
            [
                ("食べ", "食べる", "irrealis", None),
                ("させ", "させる", "irrealis", None),
                ("られ", "られる", "continuative", None),
                ("た", "た", None, None),
            ],
        ),
    ],
)
async def test_actual_inflection_components_follow_every_click_and_selection(
    text: str, term: str, expected: list[tuple[str, str, str | None, str | None]]
) -> None:
    store = cast(DictionaryStore, MemoryStore([entry(term)]))
    requests = [DictionaryLookupRequest(text=text, position=i) for i in range(len(text))]
    requests.append(DictionaryLookupRequest(text=text))
    for request in requests:
        result = await lookup(store, request)
        match = result.matches[0]
        assert (match.term, match.surface) == (term, text)
        assert "".join(part.surface for part in match.inflection) == text
        assert [
            (p.surface, p.dictionary_form, p.form, p.sound_change) for p in match.inflection
        ] == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text,term", [("食べる", "食べる"), ("猫", "猫"), ("読もう", "読む"), ("読みゃ", "読む")]
)
async def test_plain_and_unmapped_forms_do_not_gain_invented_six_form_labels(
    text: str, term: str
) -> None:
    result = await lookup(
        cast(DictionaryStore, MemoryStore([entry(term)])),
        DictionaryLookupRequest(text=text, position=0),
    )
    assert result.matches[0].inflection == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text,expected",
    [
        ("食べさせる", "irrealis"),
        ("食べまい", "irrealis"),
        ("食べず", "irrealis"),
        ("食べざる", "irrealis"),
        ("食べました", "continuative"),
    ],
)
async def test_short_selection_uses_observed_following_auxiliary(text: str, expected: str) -> None:
    result = await lookup(
        cast(DictionaryStore, MemoryStore([entry("食べる")])),
        DictionaryLookupRequest(text=text, selection_start=0, selection_end=2),
    )
    assert result.matches[0].inflection[0].form == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "suffix,expected", [("", None), ("。", "terminal"), ("部屋", "attributive")]
)
async def test_terminal_attributive_labels_need_right_context(
    suffix: str, expected: str | None
) -> None:
    result = await lookup(
        cast(DictionaryStore, MemoryStore([entry("空く")])),
        DictionaryLookupRequest(text="空いていない" + suffix, position=0),
    )
    assert result.matches[0].inflection[-1].form == expected


@pytest.mark.asyncio
async def test_literal_and_sequence_siblings_cannot_supply_another_hits_inflection() -> None:
    store = MemoryStore(
        [
            entry("食べる", id=1, sequence=8),
            entry("別名", id=2, sequence=8, definition="別の释义"),
            entry("食べました", id=3),
        ]
    )
    result = await lookup(
        cast(DictionaryStore, store), DictionaryLookupRequest(text="食べました", position=3)
    )
    restored = next(m for m in result.matches if m.term == "食べる")
    literal = next(m for m in result.matches if m.term == "食べました")
    assert [p.surface for p in restored.inflection] == ["食べ", "まし", "た"]
    assert literal.inflection == []
    assert [n.text for n in restored.definitions] == ["释义", "別の释义"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text,term",
    [
        ("わかっている", "分かる"),
        ("のんでいる", "飲む"),
        ("きている", "来る"),
        ("よかった", "良い"),
        ("できなかった", "出来る"),
    ],
)
async def test_normalized_spellings_keep_verified_source_morphology(text: str, term: str) -> None:
    result = await lookup(
        cast(DictionaryStore, MemoryStore([entry(term)])),
        DictionaryLookupRequest(text=text, position=0),
    )
    match = result.matches[0]
    assert match.term == term
    assert match.inflection
    expected = "irrealis" if text == "できなかった" else "continuative"
    assert match.inflection[0].form == expected
    assert "".join(part.surface for part in match.inflection) == text


@pytest.mark.asyncio
async def test_normalized_potential_derivation_cannot_masquerade_as_six_form_inflection() -> None:
    result = await lookup(
        cast(DictionaryStore, MemoryStore([entry("書く", rules="v5")])),
        DictionaryLookupRequest(text="書けない", position=0),
    )
    assert result.matches[0].term == "書く"
    assert result.matches[0].inflection == []


@pytest.mark.asyncio
async def test_explicit_selection_neither_expands_nor_shrinks() -> None:
    text = "日本語を食べました。"
    store = MemoryStore([entry("日本語"), entry("語", id=2), entry("食べる", id=3)])
    assert await query(
        store,
        DictionaryLookupRequest(
            text=text,
            selection_start=2,
            selection_end=3,
        ),
    ) == [("語", 2, 3)]
    assert await query(
        store,
        DictionaryLookupRequest(
            text=text,
            selection_start=4,
            selection_end=9,
        ),
    ) == [("食べる", 4, 9)]
    assert (
        await query(
            store,
            DictionaryLookupRequest(
                text=text,
                selection_start=0,
                selection_end=9,
            ),
        )
        == []
    )


@pytest.mark.asyncio
async def test_same_span_reading_soft_hint_keeps_other_readings_and_longer_literal_first() -> None:
    text = "人気者"
    store = MemoryStore(
        [
            entry("人気", id=1, reading="ひとけ"),
            entry("人気", id=2, reading="にんき"),
            entry("人気者", id=3),
        ]
    )
    request = DictionaryLookupRequest(
        text=text,
        position=1,
        tokens=[token(text, 0, 2, reading="ニンキ")],
    )
    result = await lookup(cast(DictionaryStore, store), request)
    assert [(m.term, m.reading) for m in result.matches] == [
        ("人気者", ""),
        ("人気", "にんき"),
        ("人気", "ひとけ"),
    ]


@pytest.mark.asyncio
async def test_lemma_and_pos_are_soft_ties_not_filters() -> None:
    text = "見る"
    store = MemoryStore(
        [
            entry("見る", id=1, reading="みる", rules="v5"),
            entry("見る", id=2, reading="みる", rules="v1"),
            entry("観る", id=3, reading="みる", rules="v1"),
        ]
    )
    request = DictionaryLookupRequest(
        text=text,
        position=0,
        tokens=[
            token(
                text,
                0,
                2,
                lemma="見る",
                reading="ミル",
                pos=["動詞", "一般", "*", "*", "上一段-マ行", "終止形-一般"],
            )
        ],
    )
    # Reading lookup may recall alternate spellings, but the actual lemma wins a tie.
    result = await lookup(cast(DictionaryStore, store), request)
    assert [m.id for m in result.matches][:2] == ["test-v1:entry:2", "test-v1:entry:1"]


@pytest.mark.asyncio
async def test_sequence_uses_best_hit_and_keeps_ordered_distinct_sibling_definitions() -> None:
    store = MemoryStore(
        [
            entry("短", id=1, sequence=7, definition="第一释义"),
            entry("長い表記", id=2, sequence=7, definition="第二释义"),
            entry("別名", id=3, sequence=7, definition="第一释义"),
            entry("長い表記", id=4, sequence=None, definition="独立一"),
            entry("長い表記", id=5, sequence=None, definition="独立二"),
            entry("長い表記", id=6, sequence=7, dictionary_id="other-v1", definition="另一本词典"),
        ]
    )
    result = await lookup(
        cast(DictionaryStore, store), DictionaryLookupRequest(text="長い表記", position=2)
    )
    assert len(result.matches) == 4
    merged = result.matches[0]
    assert (merged.term, merged.start, merged.end) == ("長い表記", 0, 4)
    assert [node.text for node in merged.definitions] == ["第一释义", "第二释义"]
    assert store.find_calls == store.sequence_calls == 1


@pytest.mark.asyncio
async def test_stale_hints_fall_back_and_unicode_offsets_use_original_codepoints() -> None:
    text = "𠮷はｶﾀｶﾅを読む"
    stale = token("古い文", 0, 3)
    store = MemoryStore([entry("カタカナ")])
    assert await query(store, DictionaryLookupRequest(text=text, position=4, tokens=[stale])) == [
        ("カタカナ", 2, 6),
    ]


def test_recall_is_bounded_even_with_long_text_and_many_hints() -> None:
    text = "あ" * 8192
    request = DictionaryLookupRequest(text=text, position=4096)
    candidates = _candidates(request)
    assert all(c.end - c.start <= MAX_WORD_LENGTH and c.start <= 4096 < c.end for c in candidates)
    assert len({c.key for c in candidates}) <= 64
    assert len(candidates) < 2000


@pytest.mark.asyncio
async def test_partial_auxiliary_hint_preserves_offline_deinflection() -> None:
    text = "食べました"
    hint = token(
        text, 2, 4, lemma="ます", pos=["助動詞", "*", "*", "*", "助動詞-マス", "連用形-一般"]
    )
    store = MemoryStore([entry("食べる")])
    assert await query(store, DictionaryLookupRequest(text=text, position=3, tokens=[hint])) == [
        ("食べる", 0, 5),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text,lemma,reading,homophone,stem_reading",
    [
        ("見ました", "見る", "みる", "身", "み"),
        ("食べました", "食べる", "たべる", "田部", "たべ"),
        ("みました", "見る", "みる", "身", "み"),
    ],
)
async def test_inflected_stem_homophone_cannot_borrow_auxiliary_range(
    text: str,
    lemma: str,
    reading: str,
    homophone: str,
    stem_reading: str,
) -> None:
    store = MemoryStore(
        [
            entry(lemma, id=1, reading=reading, rules="v1"),
            entry(homophone, id=2, reading=stem_reading),
        ]
    )
    for position in range(len(text)):
        request = DictionaryLookupRequest(text=text, position=position)
        matches = await query(store, request)
        assert matches[0] == (lemma, 0, len(text))
        assert all(term != homophone or end <= len(stem_reading) for term, _, end in matches)
        result = await lookup(cast(DictionaryStore, store), request)
        assert all(not match.inflection for match in result.matches if match.term == homophone)


@pytest.mark.asyncio
async def test_boundary_only_hints_keep_local_inflections() -> None:
    request = DictionaryLookupRequest.model_validate(
        {
            "text": "見ました",
            "position": 2,
            "tokens": [{"start": 0, "end": 4, "surface": "見ました"}],
        }
    )
    assert await query(MemoryStore([entry("見る")]), request) == [("見る", 0, 4)]


@pytest.mark.asyncio
@pytest.mark.parametrize("pos", [[], ["名詞"], ["動詞", "*", "*", "*"]])
async def test_reading_hint_works_without_complete_pos(pos: list[str]) -> None:
    request = DictionaryLookupRequest.model_validate(
        {
            "text": "人気",
            "position": 1,
            "tokens": [{"start": 0, "end": 2, "surface": "人気", "reading": "ヒトケ", "pos": pos}],
        }
    )
    store = MemoryStore(
        [entry("人気", id=1, reading="にんき"), entry("人気", id=2, reading="ひとけ")]
    )
    result = await lookup(cast(DictionaryStore, store), request)
    assert [match.reading for match in result.matches] == ["ひとけ", "にんき"]


@pytest.mark.asyncio
async def test_lemma_hint_works_without_pos_or_reading() -> None:
    request = DictionaryLookupRequest.model_validate(
        {
            "text": "かなわず",
            "position": 2,
            "tokens": [
                {"start": 0, "end": 4, "surface": "かなわず", "dictionary_form": "合成見出し"}
            ],
        }
    )
    assert await query(MemoryStore([entry("合成見出し")]), request) == [("合成見出し", 0, 4)]


def complete_inflection_request() -> DictionaryLookupRequest:
    text = "食べました"
    return DictionaryLookupRequest(
        text=text,
        position=3,
        tokens=[
            token(
                text,
                0,
                2,
                lemma="食べる",
                reading="タベ",
                pos=["動詞", "一般", "*", "*", "下一段-バ行", "連用形-一般"],
            ),
            token(
                text,
                2,
                4,
                lemma="ます",
                reading="マシ",
                pos=["助動詞", "*", "*", "*", "助動詞-マス", "連用形-一般"],
            ),
            token(
                text,
                4,
                5,
                lemma="た",
                reading="タ",
                pos=["助動詞", "*", "*", "*", "助動詞-タ", "終止形-一般"],
            ),
        ],
    )


@pytest.mark.asyncio
async def test_complete_aligned_hints_avoid_retokenization(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(text: str) -> tuple[MaterialReadingToken, ...]:
        raise AssertionError("Complete material analysis must be reused")

    monkeypatch.setattr(dictionary_lookup, "_analyze", forbidden)
    assert await query(MemoryStore([entry("食べる")]), complete_inflection_request()) == [
        ("食べる", 0, 5),
    ]
    result = await lookup(
        cast(DictionaryStore, MemoryStore([entry("食べる")])), complete_inflection_request()
    )
    assert [p.form for p in result.matches[0].inflection] == ["continuative", "continuative", None]


@pytest.mark.asyncio
async def test_gap_in_complete_hints_retokenizes_without_losing_inflection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = dictionary_lookup._analyze  # pyright: ignore[reportPrivateUsage]
    calls: list[str] = []

    def tracked(text: str) -> tuple[MaterialReadingToken, ...]:
        calls.append(text)
        return original(text)

    monkeypatch.setattr(dictionary_lookup, "_analyze", tracked)
    request = complete_inflection_request()
    request.tokens.pop(1)
    assert await query(MemoryStore([entry("食べる")]), request) == [("食べる", 0, 5)]
    assert calls == [request.text]
