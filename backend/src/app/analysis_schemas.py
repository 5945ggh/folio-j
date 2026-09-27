"""Analysis read models and explicit Section edit request."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


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
