"""Analysis reads, manual writes and explicit Section edit requests."""

import unicodedata
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

AnalysisWriteErrorCode = Literal[
    "not_found", "stale_text", "stale_revision", "idempotency_conflict", "no_changes"
]


class AnalysisWriteErrorResponse(BaseModel):
    code: AnalysisWriteErrorCode
    detail: str


class AnalysisValidationIssue(BaseModel):
    loc: list[str | int]
    msg: str
    type: str


class AnalysisValidationErrorResponse(BaseModel):
    detail: list[AnalysisValidationIssue]


class ManualAnalysisInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: UUID
    expected_text_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    source_md: str = Field(min_length=1, max_length=500_000)

    @field_validator("source_md", mode="before")
    @classmethod
    def normalize_source(cls, value: object) -> object:
        return unicodedata.normalize("NFC", value) if isinstance(value, str) else value

    @field_validator("source_md")
    @classmethod
    def require_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("讲解正文不能为空白")
        return value


class ManualAnalysisCreate(ManualAnalysisInput):
    origin: Literal["manual", "import"] = "manual"
    title: str | None = Field(default=None, max_length=200)

    @field_validator("title", mode="before")
    @classmethod
    def normalize_title(cls, value: object) -> object:
        if isinstance(value, str):
            return unicodedata.normalize("NFC", value.strip()) or None
        return value


class ManualAnalysisRevisionCreate(ManualAnalysisInput):
    base_revision_id: str = Field(pattern=r"^[0-7][0-9A-HJKMNP-TV-Z]{25}$")


class AnalysisListItem(BaseModel):
    id: str
    segment_id: str
    title: str
    excerpt: str
    current_revision_id: str
    created_at: datetime
    updated_at: datetime


class SectionRead(BaseModel):
    id: str
    uid: str
    handle: str
    kind: str
    display_no: str
    title: str | None
    raw: str
    start_line: int
    end_line: int


class AnalysisDetail(AnalysisListItem):
    revision_id: str
    parent_revision_id: str | None
    origin: str
    run_id: str | None
    source_md: str
    normalizer_version: int
    warnings: list[str]
    sections: list[SectionRead]


class AnalysisDeleteImpact(BaseModel):
    analysis_id: str
    title: str
    revision_count: int
    section_count: int
    occurrence_count: int = 0


class SectionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=500)
    body: str = ""


class SectionOperation(BaseModel):
    """One reviewed operation, bound to a concrete base revision."""

    model_config = ConfigDict(extra="forbid")
    kind: Literal["update_section", "insert_sections", "delete_section", "update_preamble"]
    sid: str | None = None
    after_sid: str | None = None
    title: str | None = None
    body: str | None = None
    sections: list[SectionInput] | None = None
