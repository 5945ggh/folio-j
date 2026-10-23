"""Independent translation settings, persistent tasks and explicit adoption."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from app.provenance_schemas import MaterialProvenance, ProvenancePart
from app.schemas import SegmentResponse, StrictInput


class TranslationSettingsUpdate(StrictInput):
    expected_revision: int = Field(ge=0)
    name: str = Field(default="默认翻译", min_length=1, max_length=100)
    model_id: str | None = None
    target_language: str = Field(default="简体中文", min_length=1, max_length=100)
    before_sentences: int = Field(default=3, ge=0, le=100)
    after_sentences: int = Field(default=0, ge=0, le=100)
    before_characters: int = Field(default=200, ge=0, le=100000)
    after_characters: int = Field(default=0, ge=0, le=100000)


class TranslationSettingsResponse(BaseModel):
    id: str
    adapter: Literal["llm"] = "llm"
    revision: int
    name: str
    model_id: str | None
    target_language: str
    before_sentences: int
    after_sentences: int
    before_characters: int
    after_characters: int
    max_target_characters: int = 2000
    max_context_characters: int = 2000


class TranslationCreate(StrictInput):
    request_id: UUID
    source_id: str
    material_provenance: MaterialProvenance
    text: str = Field(min_length=1, max_length=100000)
    context_before: str = Field(default="", max_length=100000)
    context_after: str = Field(default="", max_length=100000)


class TranslationTaskResponse(BaseModel):
    id: str
    source_id: str
    material_id: str
    status: Literal[
        "queued", "running", "stopping", "succeeded", "failed", "cancelled", "interrupted"
    ]
    result_id: str | None
    run_id: str | None
    error: str | None
    text: str
    material_provenance: MaterialProvenance
    context_before: str
    context_after: str
    created_at: datetime


class TranslationResultResponse(BaseModel):
    id: str
    task_id: str
    adopted_segment_ids: list[str]
    source_id: str
    material_id: str
    material_deleted: bool
    material_provenance: MaterialProvenance
    identity_sha256: str
    chapter_id: str
    parts: list[ProvenancePart]
    text: str
    translation: str
    context_before: str
    context_after: str
    target_language: str
    scheme_name: str
    scheme_id: str
    scheme_revision: int
    prompt_version: str
    provider_name: str
    protocol: str
    temperature: float | None
    max_output_tokens: int | None
    reasoning_effort: str | None
    model_id: str
    run_id: str
    created_at: datetime


class TranslationHistoryResponse(BaseModel):
    results: list[TranslationResultResponse]
    tasks: list[TranslationTaskResponse]
    next_offset: int | None


class MaterialChapterTranslation(BaseModel):
    identity_sha256: str
    result_id: str
    material_provenance: MaterialProvenance
    excerpt: str
    translation_excerpt: str
    result_count: int
    target_language: str
    created_at: datetime


class MaterialChapterTranslations(BaseModel):
    items: list[MaterialChapterTranslation]
    next_cursor: str | None
    unavailable_count: int


class TranslationAdopt(StrictInput):
    request_id: UUID
    segment_id: str | None = None
    expected_revision: int | None = Field(default=None, ge=1)
    text_sha256: str | None = None
    translation: str = Field(default_factory=str, max_length=100000)
    context_before: str = Field(default_factory=str, max_length=100000)
    context_after: str = Field(default_factory=str, max_length=100000)
    note: str = Field(default="", max_length=100000)


class TranslationAdoptionResponse(BaseModel):
    id: str
    result_id: str
    segment: SegmentResponse


class TranslationDeleteImpact(BaseModel):
    material_id: str
    hidden_result_count: int
    retained_result_count: int
    active_task_count: int
