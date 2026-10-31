"""Format-independent statistics over immutable text and lexical resources."""

import hashlib
import unicodedata
from collections import Counter
from collections.abc import Iterator, Sequence

from pydantic import BaseModel, ConfigDict, Field

from app.nlp.contracts import (
    DecodedReadings,
    MaterialReadingToken,
    MaterialResourceReadings,
    TextResource,
)

TEXT_RULE_VERSION = "text-statistics-v1"
LEXICAL_RULE_VERSION = "lexical-statistics-v1"
EXCLUDED_POS = frozenset({"空白", "記号", "補助記号"})
DICTIONARY_FORM_PLACEHOLDERS = frozenset({"*"})
KANJI_NAME_PREFIXES = ("CJK UNIFIED IDEOGRAPH-", "CJK COMPATIBILITY IDEOGRAPH-")
COVERAGE_TARGET_PERCENTAGES = (80, 90, 95)
MAX_COVERAGE_POINTS = 512


class StatisticsResult(BaseModel):
    model_config = ConfigDict(frozen=True)


class TextStatistics(StatisticsResult):
    rule_version: str = TEXT_RULE_VERSION
    unicode_version: str
    resource_count: int = Field(ge=0)
    character_count: int = Field(ge=0)
    unique_kanji_count: int = Field(ge=0)
    singleton_kanji_count: int = Field(ge=0)


class CoveragePoint(StatisticsResult):
    vocabulary_size: int = Field(ge=0)
    coverage: float = Field(ge=0, le=1)


class CoverageThreshold(StatisticsResult):
    target: float = Field(ge=0, le=1)
    vocabulary_size: int | None = Field(ge=0)


class LexicalStatistics(StatisticsResult):
    rule_version: str = LEXICAL_RULE_VERSION
    counted_token_count: int = Field(ge=0)
    distinct_word_count: int = Field(ge=0)
    singleton_word_count: int = Field(ge=0)
    singleton_word_ratio: float | None = Field(ge=0, le=1)
    coverage: tuple[CoveragePoint, ...]
    thresholds: tuple[CoverageThreshold, ...]


def compute_text(inputs: Sequence[TextResource]) -> TextStatistics:
    resources = _unique_sources(inputs)
    kanji: Counter[str] = Counter()
    character_count = 0
    for resource in resources.values():
        character_count += len(resource.text)
        kanji.update(
            character
            for character in resource.text
            if unicodedata.name(character, "").startswith(KANJI_NAME_PREFIXES)
        )
    return TextStatistics(
        unicode_version=unicodedata.unidata_version,
        resource_count=len(resources),
        character_count=character_count,
        unique_kanji_count=len(kanji),
        singleton_kanji_count=sum(count == 1 for count in kanji.values()),
    )


def counted_tokens(
    inputs: Sequence[TextResource], decoded: DecodedReadings
) -> Iterator[tuple[TextResource, MaterialReadingToken, str]]:
    """Validate and yield unique-resource tokens under the shared lexical rules."""
    _unique_sources(inputs)
    if len(inputs) != len(decoded.resources):
        raise ValueError("统计分析资源数量与正文不一致")
    seen: dict[str, MaterialResourceReadings] = {}
    for source, resource in zip(inputs, decoded.resources, strict=True):
        if source.resource_id != resource.resource_id or source.text_sha256 != resource.text_sha256:
            raise ValueError("统计分析资源身份或正文摘要不一致")
        previous_resource = seen.get(resource.resource_id)
        if previous_resource is not None:
            if previous_resource != resource:
                raise ValueError("同一资源的分析结果不一致")
            continue
        seen[resource.resource_id] = resource
        previous = 0
        for token in resource.tokens:
            # Validate while counting so direct callers need no decoder setup or
            # a second token pass. Zero-width records remain valid source data.
            if (
                not previous <= token.start <= token.end <= len(source.text)
                or source.text[token.start : token.end] != token.surface
            ):
                raise ValueError("统计分析位置与原文不一致")
            if source.text[previous : token.start].strip():
                raise ValueError("统计分析遗漏原文")
            if len(token.pos) != 6:
                raise ValueError("统计分析词性字段不是六项")
            previous = token.end
            if (
                token.end == token.start
                or not token.surface.strip()
                or token.pos[0] in EXCLUDED_POS
            ):
                continue
            form = token.dictionary_form
            key = (
                token.surface
                if not form or not form.strip() or form.strip() in DICTIONARY_FORM_PLACEHOLDERS
                else form
            )
            yield source, token, key
        if source.text[previous:].strip():
            raise ValueError("统计分析遗漏原文结尾")


def compute_lexical(inputs: Sequence[TextResource], decoded: DecodedReadings) -> LexicalStatistics:
    frequencies = Counter(key for _, _, key in counted_tokens(inputs, decoded))
    total = frequencies.total()
    distinct = len(frequencies)
    singleton = sum(count == 1 for count in frequencies.values())
    coverage, thresholds = _coverage(frequencies, total)
    return LexicalStatistics(
        counted_token_count=total,
        distinct_word_count=distinct,
        singleton_word_count=singleton,
        singleton_word_ratio=singleton / distinct if distinct else None,
        coverage=coverage,
        thresholds=thresholds,
    )


def _unique_sources(inputs: Sequence[TextResource]) -> dict[str, TextResource]:
    resources: dict[str, TextResource] = {}
    for resource in inputs:
        previous = resources.get(resource.resource_id)
        if previous is not None:
            if previous != resource:
                raise ValueError("同一资源的正文或摘要不一致")
            continue
        if hashlib.sha256(resource.text.encode()).hexdigest() != resource.text_sha256:
            raise ValueError("统计正文摘要不一致")
        resources[resource.resource_id] = resource
    return resources


def _coverage(
    frequencies: Counter[str], total: int
) -> tuple[tuple[CoveragePoint, ...], tuple[CoverageThreshold, ...]]:
    if not total:
        return (), tuple(
            CoverageThreshold(target=target / 100, vocabulary_size=None)
            for target in COVERAGE_TARGET_PERCENTAGES
        )
    distinct = len(frequencies)
    # Reserve one slot per threshold before sampling; coincident thresholds
    # share a point. No full per-word curve is materialized for large inputs.
    sample_count = MAX_COVERAGE_POINTS - len(COVERAGE_TARGET_PERCENTAGES)
    ranks = (
        set(range(distinct + 1))
        if distinct < MAX_COVERAGE_POINTS
        else {index * distinct // (sample_count - 1) for index in range(sample_count)}
    )
    cumulative = 0
    counts = {0: 0}
    thresholds: list[CoverageThreshold] = []
    for rank, (_, frequency) in enumerate(
        sorted(frequencies.items(), key=lambda item: (-item[1], item[0])), start=1
    ):
        cumulative += frequency
        threshold_point = False
        while (
            len(thresholds) < len(COVERAGE_TARGET_PERCENTAGES)
            and cumulative * 100 >= COVERAGE_TARGET_PERCENTAGES[len(thresholds)] * total
        ):
            thresholds.append(
                CoverageThreshold(
                    target=COVERAGE_TARGET_PERCENTAGES[len(thresholds)] / 100,
                    vocabulary_size=rank,
                )
            )
            threshold_point = True
        if rank in ranks or threshold_point:
            counts[rank] = cumulative
    return (
        tuple(
            CoveragePoint(vocabulary_size=rank, coverage=count / total)
            for rank, count in sorted(counts.items())
        ),
        tuple(thresholds),
    )
