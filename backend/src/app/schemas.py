"""Validated API input and output for the first Source/Segment slice."""

import unicodedata
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.provenance_schemas import MaterialProvenance


class StrictInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _title(value: str) -> str:
    normalized = unicodedata.normalize("NFC", value.strip())
    if not normalized or len(normalized) > 200:
        raise ValueError("标题须为 1–200 字符")
    return normalized


def _text(value: str) -> str:
    normalized = unicodedata.normalize("NFC", value)
    if not normalized.strip() or len(normalized) > 100000:
        raise ValueError("目标原文须非空白且最多 100000 字符")
    return normalized


def _optional(value: str) -> str:
    normalized = unicodedata.normalize("NFC", value)
    if len(normalized) > 100000:
        raise ValueError("文本最多 100000 字符")
    return normalized


class SourceCreate(StrictInput):
    title: str
    description: str = ""
    note: str = ""

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str) -> str:
        return _title(value)

    @field_validator("description", "note")
    @classmethod
    def normalize_optional(cls, value: str) -> str:
        return _optional(value)


class SourceUpdate(StrictInput):
    # Factories make fields omittable without OpenAPI defaults that imply required TS fields.
    title: str = Field(default_factory=str)
    description: str = Field(default_factory=str)
    note: str = Field(default_factory=str)

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str) -> str:
        return _title(value)

    @field_validator("description", "note")
    @classmethod
    def normalize_optional(cls, value: str) -> str:
        return _optional(value)


class SourceResponse(BaseModel):
    id: str
    title: str
    description: str
    note: str
    created_at: datetime
    updated_at: datetime
    segment_count: int


class SourceDeleteImpact(BaseModel):
    material_count: int = 0
    source_id: str
    title: str
    segment_count: int
    thread_count: int
    message_count: int
    active_job_count: int
    analysis_count: int = 0


class SegmentDeleteImpact(BaseModel):
    segment_id: str
    thread_count: int
    message_count: int
    active_job_count: int
    analysis_count: int = 0


class SegmentCreate(StrictInput):
    text: str | None = None
    request_id: UUID | None = None
    material_provenance: MaterialProvenance | None = None
    translation: str = ""
    context_before: str = ""
    context_after: str = ""
    transcription: str = ""
    note: str = ""
    source_ref: str = ""

    @field_validator("text")
    @classmethod
    def normalize_text(cls, value: str | None) -> str | None:
        return _text(value) if value is not None else None

    @field_validator(
        "translation", "context_before", "context_after", "transcription", "note", "source_ref"
    )
    @classmethod
    def normalize_optional(cls, value: str) -> str:
        return _optional(value)

    @model_validator(mode="after")
    def require_creation_target(self) -> "SegmentCreate":
        if self.material_provenance is not None:
            if self.request_id is None:
                raise ValueError("材料出处创建须携带 request_id")
        elif self.text is None:
            raise ValueError("手动片段须提供目标原文")
        return self


class SegmentUpdate(StrictInput):
    expected_revision: int | None = Field(default=None, ge=1)
    # String factories never reach storage unless explicitly supplied.
    text: str = Field(default_factory=str)
    translation: str = Field(default_factory=str)
    context_before: str = Field(default_factory=str)
    context_after: str = Field(default_factory=str)
    transcription: str = Field(default_factory=str)
    note: str = Field(default_factory=str)
    source_ref: str = Field(default_factory=str)

    @field_validator("text")
    @classmethod
    def normalize_text(cls, value: str) -> str:
        return _text(value)

    @field_validator(
        "translation", "context_before", "context_after", "transcription", "note", "source_ref"
    )
    @classmethod
    def normalize_optional(cls, value: str) -> str:
        return _optional(value)


class SegmentResponse(BaseModel):
    material_provenance: MaterialProvenance | None = None
    id: str
    source_id: str
    text: str
    text_sha256: str
    translation: str
    context_before: str
    context_after: str
    transcription: str
    note: str
    source_ref: str
    created_at: datetime
    updated_at: datetime
    text_locked_at: datetime | None
    revision: int


class SegmentProvenanceMatches(BaseModel):
    segments: list[SegmentResponse]
    truncated: bool
