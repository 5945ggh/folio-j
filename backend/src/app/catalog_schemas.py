"""Generated public catalog and explicit material usage contracts."""

from datetime import datetime
from typing import Generic, Literal, TypeVar

from pydantic import BaseModel, Field

from app.analysis_schemas import AnalysisListItem
from app.material_schemas import MaterialSummary
from app.schemas import SegmentResponse, SourceResponse, StrictInput

ReadingStatus = Literal["not_started", "in_progress", "completed"]
T = TypeVar("T")


class CatalogPage(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    page_size: int


class MaterialUsageResponse(BaseModel):
    material_id: str
    status: ReadingStatus
    revision: int
    last_opened_at: datetime | None
    updated_at: datetime


class MaterialOpenedInput(StrictInput):
    action_id: str = Field(min_length=1, max_length=100)
    expected_revision: int = Field(ge=0)


class MaterialUsageInput(StrictInput):
    status: ReadingStatus
    expected_revision: int = Field(ge=0)


class MaterialCatalogItem(MaterialSummary):
    type: Literal["book"] = "book"
    source_title: str
    cover_url: str | None
    status: ReadingStatus
    usage_revision: int
    last_opened_at: datetime | None


class SourceCatalogItem(SourceResponse):
    material_count: int
    analysis_count: int


class AnalysisCatalogItem(AnalysisListItem):
    segment_excerpt: str


class MaterialCatalogPage(CatalogPage[MaterialCatalogItem]):
    pass


class SourceCatalogPage(CatalogPage[SourceCatalogItem]):
    pass


class SegmentProvenanceSummary(BaseModel):
    display: str | None = None
    title: str | None = None
    chapter_title: str | None = None
    chapter_percent: int | None = Field(default=None, ge=0, le=99)
    status: Literal[
        "resolved",
        "material_deleted",
        "version_unavailable",
        "snapshot_mismatch",
        "invalid_reference",
        "none",
    ]


class SegmentCatalogItem(SegmentResponse):
    provenance_summary: SegmentProvenanceSummary


class SegmentCatalogPage(CatalogPage[SegmentCatalogItem]):
    pass


class AnalysisCatalogPage(CatalogPage[AnalysisCatalogItem]):
    pass
