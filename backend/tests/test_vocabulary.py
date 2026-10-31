"""Hand-counted lexical browsing contracts over format-independent resources."""

import pytest
from test_statistics import characters, source, token

from app.nlp.contracts import DecodedReadings, MaterialReadingToken, TextResource
from app.nlp.statistics import compute_lexical
from app.nlp.vocabulary import VocabularySort, compute_occurrences, compute_vocabulary


def vocabulary_sample() -> tuple[list[TextResource], DecodedReadings]:
    specifications = [
        ("生", "生", "セイ", "名詞", False),
        ("生", "生", "ナマ", "形状詞", True),
        ("生きた", "生きる", "イキタ", "動詞", False),
        ("生きる", "生きる", "イキル", "動詞", False),
        ("猫", "*", "ネコ", "名詞", False),
        ("猫", "", "ネコ", "名詞", False),
        ("犬", "犬", "イヌ", "名詞", False),
        ("。", "。", "。", "補助記号", False),
    ]
    inputs = [source("plain-text", " ".join(item[0] for item in specifications))]
    decoded = characters(inputs)
    records: list[MaterialReadingToken] = []
    offset = 0
    for surface, form, reading, pos, is_oov in specifications:
        records.append(token(offset, surface, form=form, reading=reading, pos=pos, is_oov=is_oov))
        offset += len(surface) + 1
    records.append(token(len(inputs[0].text), "", form="幽霊", reading="ユウレイ"))
    decoded.resources[0].tokens = records
    return inputs, decoded


def test_dictionary_form_merges_inflections_without_losing_lexical_variants() -> None:
    inputs, decoded = vocabulary_sample()
    original = decoded.model_dump()
    result = compute_vocabulary(inputs, decoded)
    assert result.total == 4
    assert [(item.word, item.frequency) for item in result.items] == [
        ("猫", 2),
        ("生", 2),
        ("生きる", 2),
        ("犬", 1),
    ]
    items = {item.word: item for item in result.items}
    assert set(items["生きる"].surfaces) == {"生きた", "生きる"}
    assert set(items["生きる"].readings) == {"イキタ", "イキル"}
    assert set(items["生"].readings) == {"セイ", "ナマ"}
    assert {tuple(pos) for pos in items["生"].parts_of_speech} == {
        ("名詞", "*", "*", "*", "*", "*"),
        ("形状詞", "*", "*", "*", "*", "*"),
    }
    assert items["生"].oov_count == 1
    assert decoded.model_dump() == original
    assert (
        sum(item.frequency for item in result.items)
        == compute_lexical(inputs, decoded).counted_token_count
    )


def test_part_of_speech_filters_tokens_before_frequency_and_search() -> None:
    inputs, decoded = vocabulary_sample()
    nouns = compute_vocabulary(inputs, decoded, pos="名詞")
    assert [(item.word, item.frequency) for item in nouns.items] == [
        ("猫", 2),
        ("犬", 1),
        ("生", 1),
    ]
    life = next(item for item in nouns.items if item.word == "生")
    assert list(life.readings) == ["セイ"]
    assert life.oov_count == 0
    assert compute_vocabulary(inputs, decoded, pos="名詞", query="ナマ").total == 0
    assert compute_vocabulary(inputs, decoded, pos="存在しない詞性").total == 0


@pytest.mark.parametrize("query", ["生きる", "生きた", "イキタ", "いきた", "ｲｷﾀ"])
def test_search_matches_dictionary_form_surface_and_reading_without_recounting(query: str) -> None:
    inputs, decoded = vocabulary_sample()
    result = compute_vocabulary(inputs, decoded, query=query)
    assert [(item.word, item.frequency) for item in result.items] == [("生きる", 2)]


@pytest.mark.parametrize("sort", ["frequency_desc", "frequency_asc"])
def test_pagination_is_stable_across_equal_frequency_words(sort: VocabularySort) -> None:
    inputs, decoded = vocabulary_sample()
    all_items = compute_vocabulary(inputs, decoded, sort=sort)
    first = compute_vocabulary(inputs, decoded, sort=sort, offset=0, limit=2)
    second = compute_vocabulary(inputs, decoded, sort=sort, offset=2, limit=2)
    assert first.total == second.total == all_items.total == 4
    assert [*first.items, *second.items] == list(all_items.items)
    assert [item.word for item in all_items.items] == (
        ["猫", "生", "生きる", "犬"] if sort == "frequency_desc" else ["犬", "猫", "生", "生きる"]
    )
    assert not compute_vocabulary(inputs, decoded, offset=99, limit=2).items


def test_occurrences_keep_original_codepoints_context_and_token_metadata() -> None:
    inputs, decoded = vocabulary_sample()
    result = compute_occurrences(inputs, decoded, "生きる")
    assert result.total == 2
    assert [(item.start, item.end, item.surface) for item in result.items] == [
        (4, 7, "生きた"),
        (8, 11, "生きる"),
    ]
    for item in result.items:
        assert item.resource_id == "plain-text"
        assert inputs[0].text[item.start : item.end] == item.surface
        assert item.before + item.surface + item.after in inputs[0].text
        assert item.parts_of_speech[0] == "動詞"
        assert len(item.parts_of_speech) == 6
        assert not item.is_oov
    assert [item.reading for item in result.items] == ["イキタ", "イキル"]
    page = compute_occurrences(inputs, decoded, "生きる", offset=1, limit=1)
    assert page.total == 2 and list(page.items) == [result.items[1]]
    assert compute_occurrences(inputs, decoded, "生きる", pos="名詞").total == 0
    assert compute_occurrences(inputs, decoded, "存在しない").total == 0


def test_repeated_resources_are_deduplicated_but_identical_distinct_resources_are_counted() -> None:
    inputs, decoded = vocabulary_sample()
    repeated_inputs = [*inputs, inputs[0]]
    repeated = decoded.model_copy(
        update={"resources": [*decoded.resources, decoded.resources[0].model_copy(deep=True)]}
    )
    assert compute_vocabulary(repeated_inputs, repeated) == compute_vocabulary(inputs, decoded)
    assert compute_occurrences(repeated_inputs, repeated, "猫") == compute_occurrences(
        inputs, decoded, "猫"
    )
    other = source("another-resource", inputs[0].text)
    distinct = decoded.model_copy(
        update={
            "resources": [
                *decoded.resources,
                decoded.resources[0].model_copy(update={"resource_id": other.resource_id}),
            ]
        }
    )
    assert [
        (item.word, item.frequency) for item in compute_vocabulary([*inputs, other], distinct).items
    ] == [
        ("猫", 4),
        ("生", 4),
        ("生きる", 4),
        ("犬", 2),
    ]
    assert compute_occurrences([*inputs, other], distinct, "猫").total == 4


def test_conflicting_repeated_analysis_cannot_hide_behind_deduplication() -> None:
    inputs, decoded = vocabulary_sample()
    other = decoded.resources[0].model_copy(deep=True)
    other.tokens[0].reading = "コトナル"
    repeated = decoded.model_copy(update={"resources": [decoded.resources[0], other]})
    with pytest.raises(ValueError):
        compute_vocabulary([*inputs, inputs[0]], repeated)
    with pytest.raises(ValueError):
        compute_occurrences([*inputs, inputs[0]], repeated, "生")


@pytest.mark.parametrize("form", ["", " ", "\t", "*", " * "])
def test_placeholder_forms_fall_back_to_surface(form: str) -> None:
    inputs = [source("r", "猫猫")]
    decoded = characters(inputs)
    decoded.resources[0].tokens[0].dictionary_form = form
    result = compute_vocabulary(inputs, decoded)
    assert [(item.word, item.frequency) for item in result.items] == [("猫", 2)]
    assert compute_occurrences(inputs, decoded, "猫").total == 2


@pytest.mark.parametrize("text", ["", "。！？", " \n\t"])
def test_analyzed_but_empty_or_excluded_text_is_a_real_empty_result(text: str) -> None:
    inputs = [source("r", text)]
    result = compute_vocabulary(inputs, characters(inputs))
    assert result.total == 0 and not result.items
    assert compute_occurrences(inputs, characters(inputs), "猫").total == 0


def test_variant_samples_are_bounded_but_search_covers_omitted_variants() -> None:
    surfaces = [f"形{index:02}" for index in range(20)]
    inputs = [source("r", " ".join(surfaces))]
    decoded = characters(inputs)
    decoded.resources[0].tokens = [
        token(index * 4, surface, form="語", reading=f"ヨミ{index:02}")
        for index, surface in enumerate(surfaces)
    ]
    for index, record in enumerate(decoded.resources[0].tokens):
        record.pos[1] = f"分類{index:02}"
    all_items = compute_vocabulary(inputs, decoded)
    item = all_items.items[0]
    assert item.frequency == 20 and item.variants_truncated
    assert len(item.readings) == len(item.surfaces) == 8
    assert len(item.parts_of_speech) == 16
    assert "ヨミ19" not in item.readings and "形19" not in item.surfaces
    for query in ("ヨミ19", "形19"):
        result = compute_vocabulary(inputs, decoded, query=query)
        assert result.total == 1 and result.items == all_items.items


def test_search_normalizes_decomposed_japanese_to_nfc() -> None:
    inputs = [source("r", "が")]
    decoded = characters(inputs)
    decoded.resources[0].tokens[0].reading = "ガ"
    result = compute_vocabulary(inputs, decoded, query="カ\u3099")
    assert result.query == "ガ" and result.total == 1
