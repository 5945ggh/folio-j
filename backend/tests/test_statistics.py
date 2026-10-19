"""Hand-counted text statistics, independent of EPUB and reader API schemas."""

import hashlib
import unicodedata

import pytest
from pydantic import ValidationError

from app.nlp.assets import decode
from app.nlp.contracts import (
    DecodedReadings,
    MaterialReadingToken,
    MaterialResourceReadings,
    TextResource,
)
from app.nlp.statistics import (
    LEXICAL_RULE_VERSION,
    MAX_COVERAGE_POINTS,
    TEXT_RULE_VERSION,
    compute_lexical,
    compute_text,
)
from app.nlp.tokenization import generate


def source(resource_id: str, text: str) -> TextResource:
    return TextResource(resource_id, text, hashlib.sha256(text.encode()).hexdigest())


def token(
    start: int,
    surface: str,
    *,
    form: str | None = None,
    pos: str = "名詞",
    reading: str = "",
    is_oov: bool = False,
) -> MaterialReadingToken:
    return MaterialReadingToken(
        start=start,
        end=start + len(surface),
        surface=surface,
        reading=reading,
        dictionary_form=surface if form is None else form,
        normalized_form=surface,
        pos=[pos, "*", "*", "*", "*", "*"],
        is_oov=is_oov,
    )


def characters(inputs: list[TextResource]) -> DecodedReadings:
    return DecodedReadings(
        configuration="{}",
        resources=[
            MaterialResourceReadings(
                resource_id=resource.resource_id,
                text_sha256=resource.text_sha256,
                tokens=[
                    token(
                        offset,
                        character,
                        pos="空白"
                        if character.isspace()
                        else "補助記号"
                        if character in "。！？"
                        else "名詞",
                    )
                    for offset, character in enumerate(resource.text)
                ],
            )
            for resource in inputs
        ],
    )


def basic() -> tuple[list[TextResource], DecodedReadings]:
    inputs = [source("r1", "猫猫犬。\n"), source("r2", "猫鳥")]
    return inputs, characters(inputs)


def test_hand_counted_text_and_lexical_statistics() -> None:
    inputs, decoded = basic()
    text = compute_text(inputs)
    assert text.rule_version == TEXT_RULE_VERSION
    assert text.unicode_version == unicodedata.unidata_version
    assert (text.resource_count, text.character_count) == (2, 7)
    assert (text.unique_kanji_count, text.singleton_kanji_count) == (3, 2)
    result = compute_lexical(inputs, decoded)
    assert result.rule_version == LEXICAL_RULE_VERSION
    assert result.counted_token_count == 5
    assert result.distinct_word_count == 3
    assert result.singleton_word_count == 2
    assert result.singleton_word_ratio == pytest.approx(2 / 3)
    assert [(p.vocabulary_size, p.coverage) for p in result.coverage] == [
        (0, 0),
        (1, 0.6),
        (2, 0.8),
        (3, 1),
    ]
    assert [(p.target, p.vocabulary_size) for p in result.thresholds] == [
        (0.8, 2),
        (0.9, 3),
        (0.95, 3),
    ]


def test_repeated_resource_is_counted_once_without_mutating_asset() -> None:
    inputs, decoded = basic()
    repeated = DecodedReadings(
        configuration=decoded.configuration,
        resources=[*decoded.resources, decoded.resources[0].model_copy(deep=True)],
    )
    original = repeated.model_dump()
    assert compute_text([*inputs, inputs[0]]) == compute_text(inputs)
    assert compute_lexical([*inputs, inputs[0]], repeated) == compute_lexical(inputs, decoded)
    assert repeated.model_dump() == original


def test_same_text_with_different_resource_identity_is_counted_separately() -> None:
    inputs, _ = basic()
    inputs.append(source("r3", "猫鳥"))
    text = compute_text(inputs)
    assert (text.resource_count, text.character_count) == (3, 9)
    assert (text.unique_kanji_count, text.singleton_kanji_count) == (3, 1)
    lexical = compute_lexical(inputs, characters(inputs))
    assert (lexical.counted_token_count, lexical.distinct_word_count) == (7, 3)
    assert lexical.singleton_word_count == 1


def test_same_id_different_text_or_digest_is_rejected() -> None:
    first = source("r1", "猫")
    for conflicting in (source("r1", "犬"), TextResource("r1", "猫", "broken")):
        inputs = [first, conflicting]
        with pytest.raises(ValueError, match="同一资源"):
            compute_text(inputs)
        with pytest.raises(ValueError, match="同一资源"):
            compute_lexical(inputs, characters(inputs))


def test_source_digest_and_analysis_identity_must_match() -> None:
    invalid = TextResource("r1", "猫", "broken")
    with pytest.raises(ValueError, match="摘要"):
        compute_text([invalid])
    with pytest.raises(ValueError, match="摘要"):
        compute_lexical([invalid], characters([invalid]))
    inputs, decoded = basic()
    for update in ({"resource_id": "other"}, {"text_sha256": "broken"}):
        changed = decoded.model_copy(deep=True)
        changed.resources[0] = changed.resources[0].model_copy(update=update)
        with pytest.raises(ValueError, match="身份或正文摘要"):
            compute_lexical(inputs, changed)
    with pytest.raises(ValueError, match="数量"):
        compute_lexical(inputs, decoded.model_copy(update={"resources": []}))
    with pytest.raises(ValueError, match="身份或正文摘要"):
        compute_lexical(inputs[::-1], decoded)


def test_same_id_different_analysis_is_rejected_even_if_counts_would_match() -> None:
    inputs = [source("r1", "猫"), source("r1", "猫")]
    decoded = characters(inputs)
    decoded.resources[1].tokens[0].reading = "different"
    with pytest.raises(ValueError, match="分析结果不一致"):
        compute_lexical(inputs, decoded)


def test_filters_only_specified_records_and_preserves_function_words_numbers_and_oov() -> None:
    specifications = [
        ("の", "助詞", False),
        ("ます", "助動詞", False),
        ("123", "名詞", False),
        ("謎", "名詞", True),
        ("。", "補助記号", False),
        ("☆", "記号", False),
        (" ", "空白", False),
        ("\n", "名詞", False),
        ("㍿", "名詞", False),
        ("", "名詞", False),
    ]
    text = "".join(surface for surface, _, _ in specifications)
    inputs = [source("r1", text)]
    decoded = characters(inputs)
    tokens: list[MaterialReadingToken] = []
    offset = 0
    for surface, pos, oov in specifications:
        tokens.append(token(offset, surface, pos=pos, is_oov=oov))
        offset += len(surface)
    tokens[-2].dictionary_form = "株式"
    tokens[-1].dictionary_form = "会社"
    decoded.resources[0].tokens = tokens
    original = decoded.model_dump()
    result = compute_lexical(inputs, decoded)
    assert (result.counted_token_count, result.distinct_word_count) == (5, 5)
    assert result.singleton_word_count == 5
    assert decoded.model_dump() == original


@pytest.mark.parametrize("form", ["", " ", "\t", "*", " * "])
def test_dictionary_form_fallback_uses_surface(form: str) -> None:
    inputs = [source("r1", "猫猫")]
    decoded = characters(inputs)
    decoded.resources[0].tokens[0].dictionary_form = form
    result = compute_lexical(inputs, decoded)
    assert (result.counted_token_count, result.distinct_word_count) == (2, 1)
    assert result.singleton_word_count == 0


def test_dictionary_form_merges_inflections_without_using_surface_reading() -> None:
    inputs = [source("r1", "飲ん飲み")]
    decoded = characters(inputs)
    decoded.resources[0].tokens = [
        token(0, "飲ん", form="飲む", reading="ノン"),
        token(2, "飲み", form="飲む", reading="ノミ"),
    ]
    result = compute_lexical(inputs, decoded)
    assert (result.counted_token_count, result.distinct_word_count) == (2, 1)
    assert result.singleton_word_ratio == 0


def test_normalized_form_does_not_replace_dictionary_form_key() -> None:
    inputs = [source("r1", "だた")]
    decoded = characters(inputs)
    decoded.resources[0].tokens[0].normalized_form = "た"
    assert compute_lexical(inputs, decoded).distinct_word_count == 2


def test_unicode_name_rule_counts_extensions_and_compatibility_without_expansion() -> None:
    value = "猫猫犬𠮷﨑々〇㍿かな😀 \n"
    assert unicodedata.normalize("NFC", value) == value
    result = compute_text([source("r1", value)])
    assert result.character_count == 13
    assert result.unique_kanji_count == 4
    assert result.singleton_kanji_count == 3


@pytest.mark.parametrize("text", ["", "。！？", " \n\t"])
def test_empty_or_fully_filtered_text_has_null_ratios_and_empty_curve(text: str) -> None:
    inputs = [source("r1", text)]
    result = compute_lexical(inputs, characters(inputs))
    assert result.counted_token_count == 0
    assert result.distinct_word_count == 0
    assert result.singleton_word_count == 0
    assert result.singleton_word_ratio is None
    assert result.coverage == ()
    assert [threshold.vocabulary_size for threshold in result.thresholds] == [None, None, None]
    assert [threshold.target for threshold in result.thresholds] == [0.8, 0.9, 0.95]


def test_no_resources_and_only_zero_width_records_are_valid_empty_statistics() -> None:
    assert compute_text([]).resource_count == 0
    assert compute_text([]).character_count == 0
    assert compute_lexical([], characters([])).coverage == ()
    inputs = [source("r1", "")]
    decoded = characters(inputs)
    decoded.resources[0].tokens = [token(0, "", form="会社")]
    assert compute_lexical(inputs, decoded).counted_token_count == 0


@pytest.mark.parametrize(
    ("updates", "message"),
    [
        ({"start": 1}, "位置"),
        ({"end": 9}, "位置"),
        ({"surface": "犬"}, "位置"),
        ({"pos": []}, "六项"),
    ],
)
def test_direct_call_rejects_misaligned_or_invalid_tokens(
    updates: dict[str, object], message: str
) -> None:
    inputs = [source("r1", "猫")]
    decoded = characters(inputs)
    decoded.resources[0].tokens[0] = decoded.resources[0].tokens[0].model_copy(update=updates)
    with pytest.raises(ValueError, match=message):
        compute_lexical(inputs, decoded)


def test_direct_call_checks_missing_and_overlapping_source_ranges() -> None:
    inputs = [source("r1", "猫犬鳥")]
    for records in ([token(1, "犬鳥")], [token(0, "猫犬")]):
        decoded = characters(inputs)
        decoded.resources[0].tokens = records
        with pytest.raises(ValueError, match="遗漏"):
            compute_lexical(inputs, decoded)
    decoded = characters(inputs)
    decoded.resources[0].tokens.append(token(2, "鳥"))
    with pytest.raises(ValueError, match="位置"):
        compute_lexical(inputs, decoded)


def test_coverage_thresholds_use_exact_smallest_integer_rank() -> None:
    inputs = [source("r1", "猫" * 80 + "犬" * 10 + "鳥" * 5 + "猿" * 5)]
    result = compute_lexical(inputs, characters(inputs))
    assert [threshold.vocabulary_size for threshold in result.thresholds] == [1, 2, 3]
    inputs = [source("r1", "猫" * 98 + "犬鳥")]
    result = compute_lexical(inputs, characters(inputs))
    assert [threshold.vocabulary_size for threshold in result.thresholds] == [1, 1, 1]
    assert len(result.coverage) == 4


def test_large_curve_is_bounded_and_keeps_origin_end_and_complete_sequence_thresholds() -> None:
    distinct = 1025
    inputs = [source("r1", "".join(chr(0x4E00 + index) for index in range(distinct)))]
    result = compute_lexical(inputs, characters(inputs))
    assert result.counted_token_count == distinct
    assert len(result.coverage) <= MAX_COVERAGE_POINTS
    points = {point.vocabulary_size: point.coverage for point in result.coverage}
    assert points[0] == 0
    assert points[distinct] == 1
    assert [threshold.vocabulary_size for threshold in result.thresholds] == [820, 923, 974]
    for rank in (820, 923, 974):
        assert points[rank] == rank / distinct
    ranks = [point.vocabulary_size for point in result.coverage]
    assert ranks == sorted(set(ranks))
    assert all(
        a.coverage < b.coverage for a, b in zip(result.coverage, result.coverage[1:], strict=False)
    )


def test_results_and_nested_curve_values_are_frozen() -> None:
    inputs, decoded = basic()
    text = compute_text(inputs)
    lexical = compute_lexical(inputs, decoded)
    for result, field, value in (
        (text, "character_count", 99),
        (lexical, "counted_token_count", 99),
        (lexical.coverage[0], "coverage", 1),
        (lexical.thresholds[0], "vocabulary_size", 99),
    ):
        with pytest.raises(ValidationError, match="frozen"):
            setattr(result, field, value)
    assert isinstance(lexical.coverage, tuple)
    assert isinstance(lexical.thresholds, tuple)


def test_real_local_analyzer_feeds_plain_text_statistics() -> None:
    inputs = [source("r1", "飲んだ 飲みます。")]
    generated = generate(inputs)
    result = compute_lexical(inputs, decode(generated.payload, inputs))
    assert result.counted_token_count == 4
    assert result.distinct_word_count == 3
    assert result.singleton_word_count == 2
