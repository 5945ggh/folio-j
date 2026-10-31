"""Pure paginated vocabulary queries over exact resource-local lexical assets."""

import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.nlp.contracts import DecodedReadings, TextResource
from app.nlp.statistics import LEXICAL_RULE_VERSION, counted_tokens

VOCABULARY_RULE_VERSION = "material-vocabulary-v1:" + LEXICAL_RULE_VERSION
VocabularySort = Literal["frequency_desc", "frequency_asc"]
MAX_READING_VARIANTS = 8
MAX_SURFACE_VARIANTS = 8
MAX_POS_VARIANTS = 16


class VocabularyResult(BaseModel):
    model_config = ConfigDict(frozen=True)


class VocabularyItem(VocabularyResult):
    word: str
    frequency: int = Field(ge=1)
    readings: tuple[str, ...]
    surfaces: tuple[str, ...]
    parts_of_speech: tuple[tuple[str, ...], ...]
    oov_count: int = Field(ge=0)
    variants_truncated: bool


class VocabularyPage(VocabularyResult):
    query: str
    pos: str | None
    sort: VocabularySort
    total: int = Field(ge=0)
    offset: int = Field(ge=0)
    limit: int = Field(ge=1)
    available_pos: tuple[str, ...]
    items: tuple[VocabularyItem, ...]


class VocabularyOccurrence(VocabularyResult):
    resource_id: str
    text_sha256: str
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    surface: str
    reading: str
    parts_of_speech: tuple[str, ...]
    is_oov: bool
    before: str
    after: str


class VocabularyOccurrencesPage(VocabularyResult):
    word: str
    pos: str | None
    total: int = Field(ge=0)
    offset: int = Field(ge=0)
    limit: int = Field(ge=1)
    items: tuple[VocabularyOccurrence, ...]


@dataclass
class _Word:
    frequency: int = 0
    readings: set[str] = field(default_factory=lambda: set[str]())
    surfaces: set[str] = field(default_factory=lambda: set[str]())
    parts_of_speech: set[tuple[str, ...]] = field(default_factory=lambda: set[tuple[str, ...]]())
    oov_count: int = 0


def normalize_query(value: str) -> str:
    return unicodedata.normalize("NFC", value.strip())


def _search_form(value: str) -> str:
    # Search equivalence is local to matching; original forms and grouping keys
    # remain unchanged. Sudachi readings are normally katakana.
    return "".join(
        chr(ord(character) - 0x60) if "ァ" <= character <= "ヶ" else character
        for character in unicodedata.normalize("NFKC", value)
    )


def compute_vocabulary(
    inputs: Sequence[TextResource],
    decoded: DecodedReadings,
    *,
    query: str = "",
    pos: str | None = None,
    sort: VocabularySort = "frequency_desc",
    offset: int = 0,
    limit: int = 40,
) -> VocabularyPage:
    query = normalize_query(query)
    words: dict[str, _Word] = {}
    available_pos: set[str] = set()
    for _, token, key in counted_tokens(inputs, decoded):
        available_pos.add(token.pos[0])
        if pos is not None and token.pos[0] != pos:
            continue
        word = words.get(key)
        if word is None:
            word = _Word()
            words[key] = word
        word.frequency += 1
        word.readings.add(token.reading)
        word.surfaces.add(token.surface)
        word.parts_of_speech.add(tuple(token.pos))
        word.oov_count += token.is_oov
    # Search identifies whole groups. A matching inflection or reading never
    # silently reduces the group's frequency to only that spelling's tokens.
    search = _search_form(query)
    matches = [
        (key, word)
        for key, word in words.items()
        if not query
        or any(search in _search_form(value) for value in (key, *word.surfaces, *word.readings))
    ]
    matches.sort(
        key=lambda pair: (
            -pair[1].frequency if sort == "frequency_desc" else pair[1].frequency,
            pair[0],
        )
    )
    return VocabularyPage(
        query=query,
        pos=pos,
        sort=sort,
        total=len(matches),
        offset=offset,
        limit=limit,
        available_pos=tuple(sorted(available_pos)),
        items=tuple(
            VocabularyItem(
                word=key,
                frequency=word.frequency,
                readings=tuple(sorted(word.readings)[:MAX_READING_VARIANTS]),
                surfaces=tuple(sorted(word.surfaces)[:MAX_SURFACE_VARIANTS]),
                parts_of_speech=tuple(sorted(word.parts_of_speech)[:MAX_POS_VARIANTS]),
                oov_count=word.oov_count,
                variants_truncated=(
                    len(word.readings) > MAX_READING_VARIANTS
                    or len(word.surfaces) > MAX_SURFACE_VARIANTS
                    or len(word.parts_of_speech) > MAX_POS_VARIANTS
                ),
            )
            for key, word in matches[offset : offset + limit]
        ),
    )


def compute_occurrences(
    inputs: Sequence[TextResource],
    decoded: DecodedReadings,
    word: str,
    *,
    pos: str | None = None,
    offset: int = 0,
    limit: int = 40,
) -> VocabularyOccurrencesPage:
    total = 0
    items: list[VocabularyOccurrence] = []
    for source, token, key in counted_tokens(inputs, decoded):
        if key != word or (pos is not None and token.pos[0] != pos):
            continue
        if offset <= total < offset + limit:
            items.append(
                VocabularyOccurrence(
                    resource_id=source.resource_id,
                    text_sha256=source.text_sha256,
                    start=token.start,
                    end=token.end,
                    surface=token.surface,
                    reading=token.reading,
                    parts_of_speech=tuple(token.pos),
                    is_oov=token.is_oov,
                    before=source.text[max(0, token.start - 40) : token.start],
                    after=source.text[token.end : token.end + 40],
                )
            )
        total += 1
    return VocabularyOccurrencesPage(
        word=word, pos=pos, total=total, offset=offset, limit=limit, items=tuple(items)
    )
