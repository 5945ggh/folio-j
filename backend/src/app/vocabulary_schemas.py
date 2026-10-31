"""Vocabulary API projections preserve material, version and lexical identities."""

from typing import Literal

from app.nlp.vocabulary import (
    VOCABULARY_RULE_VERSION,
    VocabularyPage,
    VocabularyResult,
)


class MaterialVocabularyResponse(VocabularyPage):
    material_id: str
    version_id: str
    generation_id: str | None
    analysis_configuration: str | None
    rule_version: str = VOCABULARY_RULE_VERSION
    scope: Literal["unique_resources"] = "unique_resources"
    status: Literal["ready", "unavailable"]


class MaterialVocabularyOccurrence(VocabularyResult):
    chapter_id: str | None
    chapter_title: str | None
    part_index: int | None
    spine_index: int | None
    resource_id: str
    text_sha256: str
    start: int
    end: int
    before: str
    match: str
    after: str
    reading: str
    parts_of_speech: tuple[str, ...]
    is_oov: bool


class MaterialVocabularyOccurrencesPage(VocabularyResult):
    word: str
    pos: str | None
    total: int
    offset: int
    limit: int
    items: tuple[MaterialVocabularyOccurrence, ...]


class MaterialVocabularyOccurrencesResponse(MaterialVocabularyOccurrencesPage):
    material_id: str
    version_id: str
    generation_id: str
    analysis_configuration: str
    rule_version: str = VOCABULARY_RULE_VERSION
    scope: Literal["unique_resources"] = "unique_resources"
    presentation_policy: Literal["first_navigable_spine"] = "first_navigable_spine"
