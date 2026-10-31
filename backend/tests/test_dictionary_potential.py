"""Potential-form recall preserves lexical evidence and exact source ranges."""

import pytest
from test_dictionary_lookup import MemoryStore, entry, query, token

from app.dictionary_schemas import DictionaryLookupRequest, DictionaryTokenHint
from app.services.dictionary_lookup import MAX_WORD_LENGTH


def potential_token(text: str, start: int, end: int, lemma: str) -> DictionaryTokenHint:
    # Keep normalized_form equal to dictionary_form: Sudachi's built-in normalization
    # must not supply the godan answer that this regression is intended to exercise.
    return token(
        text,
        start,
        end,
        lemma=lemma,
        reading="カナ",
        pos=["動詞", "一般", "*", "*", "下一段-マ行", "終止形-一般"],
    )


def potential_chain(text: str, start: int = 0) -> list[DictionaryTokenHint]:
    """Complete hints for 込めていない, optionally following one compound prefix."""
    hints = [token(text, 0, start, reading="カナ")] if start else []
    hints.extend(
        [
            potential_token(text, start, start + 2, "込める"),
            token(
                text,
                start + 2,
                start + 3,
                reading="テ",
                pos=["助詞", "接続助詞", "*", "*", "*", "*"],
            ),
            token(
                text,
                start + 3,
                start + 4,
                lemma="いる",
                reading="イ",
                pos=["動詞", "非自立可能", "*", "*", "上一段-ア行", "未然形-一般"],
            ),
            token(
                text,
                start + 4,
                start + 6,
                lemma="ない",
                reading="ナイ",
                pos=["助動詞", "*", "*", "*", "助動詞-ナイ", "終止形-一般"],
            ),
        ]
    )
    return hints


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "potential,godan",
    [
        ("会える", "会う"),
        ("書ける", "書く"),
        ("泳げる", "泳ぐ"),
        ("話せる", "話す"),
        ("待てる", "待つ"),
        ("死ねる", "死ぬ"),
        ("遊べる", "遊ぶ"),
        ("読める", "読む"),
        ("帰れる", "帰る"),
    ],
)
async def test_all_nine_godan_rows_without_normalized_form_shortcut(
    potential: str, godan: str
) -> None:
    store = MemoryStore([entry(godan, rules="vt v5")])
    assert await query(
        store,
        DictionaryLookupRequest(
            text=potential,
            position=1,
            tokens=[potential_token(potential, 0, len(potential), potential)],
        ),
    ) == [(godan, 0, len(potential))]


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix,suffix", [("", ""), ("🙂彼は", "。まだだ。")])
async def test_real_compound_potential_without_hints_covers_every_click_and_selection(
    prefix: str, suffix: str
) -> None:
    surface = "のみ込めていない"
    text = prefix + surface + suffix
    start, end = len(prefix), len(prefix) + len(surface)
    store = MemoryStore([entry("のみ込む", rules="v5")])
    expected = [("のみ込む", start, end)]
    for position in range(start, end):
        assert await query(store, DictionaryLookupRequest(text=text, position=position)) == expected
    assert (
        await query(
            store,
            DictionaryLookupRequest(text=text, selection_start=start, selection_end=end),
        )
        == expected
    )


@pytest.mark.asyncio
async def test_original_ichidan_lemma_keeps_priority_over_potential_godan_candidate() -> None:
    text = "込めていない"
    # Reverse dictionary order makes the original lemma's priority observable.
    store = MemoryStore([entry("込む", id=1, rules="v5"), entry("込める", id=2, rules="v1")])
    for position in range(len(text)):
        assert await query(
            store,
            DictionaryLookupRequest(text=text, position=position, tokens=potential_chain(text)),
        ) == [("込める", 0, len(text)), ("込む", 0, len(text))]


@pytest.mark.asyncio
@pytest.mark.parametrize("rules", ["", "v1", "v5u", "av5", "v5, v1"])
async def test_potential_requires_independent_godan_dictionary_rule(rules: str) -> None:
    text = "込める"
    store = MemoryStore([entry("込む", rules=rules)])
    assert (
        await query(
            store,
            DictionaryLookupRequest(
                text=text, position=0, tokens=[potential_token(text, 0, len(text), text)]
            ),
        )
        == []
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("rules", ["", "v1"])
async def test_existing_normalized_form_does_not_require_potential_godan_rule(rules: str) -> None:
    text = "込める"
    hint = potential_token(text, 0, len(text), text)
    hint.normalized_form = "込む"
    assert await query(
        MemoryStore([entry("込む", rules=rules)]),
        DictionaryLookupRequest(text=text, position=0, tokens=[hint]),
    ) == [("込む", 0, len(text))]


@pytest.mark.asyncio
async def test_potential_candidate_matches_term_without_borrowing_homophone_reading() -> None:
    text = "こめていない"
    hints = potential_chain(text)
    hints[0].dictionary_form = hints[0].normalized_form = "こめる"
    store = MemoryStore(
        [
            entry("こむ", id=1, rules="v5"),
            entry("混む", id=2, reading="こむ", rules="v5"),
        ]
    )
    assert await query(
        store,
        DictionaryLookupRequest(text=text, position=5, tokens=hints),
    ) == [("こむ", 0, len(text))]


@pytest.mark.asyncio
@pytest.mark.parametrize("conjugation", ["*", "上一段-マ行", "五段-ラ行"])
async def test_same_shape_outside_lower_ichidan_does_not_gain_potential_candidate(
    conjugation: str,
) -> None:
    text = "込める"
    pos = ["名詞", "普通名詞", "一般", "*", "*", "*"]
    if conjugation != "*":
        pos = ["動詞", "一般", "*", "*", conjugation, "終止形-一般"]
    hint = token(text, 0, len(text), lemma=text, reading="コメル", pos=pos)
    assert (
        await query(
            MemoryStore([entry("込む", rules="v5")]),
            DictionaryLookupRequest(text=text, position=0, tokens=[hint]),
        )
        == []
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("start,end", [(0, 7), (1, 8), (0, 9)])
async def test_explicit_potential_selection_cannot_expand_or_shrink(start: int, end: int) -> None:
    text = "のみ込めていない。"
    assert (
        await query(
            MemoryStore([entry("のみ込む", rules="v5")]),
            DictionaryLookupRequest(text=text, selection_start=start, selection_end=end),
        )
        == []
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("length", [MAX_WORD_LENGTH, MAX_WORD_LENGTH + 1])
async def test_potential_auxiliary_range_obeys_original_codepoint_budget(length: int) -> None:
    prefix = "𠮷" * (length - len("込めていない"))
    text = prefix + "込めていない"
    godan = prefix + "込む"
    matches = await query(
        MemoryStore([entry(godan, rules="v5")]),
        DictionaryLookupRequest(
            text=text,
            position=len(text) - 1,
            tokens=potential_chain(text, len(prefix)),
        ),
    )
    assert matches == ([(godan, 0, length)] if length == MAX_WORD_LENGTH else [])


@pytest.mark.asyncio
async def test_potential_reversal_is_single_step() -> None:
    # A deliberately synthetic lemma makes a second reversal observable:
    # あえれる -> あえる is allowed; あえる -> あう must not run again.
    text = "あえれる"
    store = MemoryStore([entry("あえる", id=1, rules="v5"), entry("あう", id=2, rules="v5")])
    assert await query(
        store,
        DictionaryLookupRequest(
            text=text, position=0, tokens=[potential_token(text, 0, len(text), text)]
        ),
    ) == [("あえる", 0, len(text))]
