"""Bounded scan pages of exact, visible learning segments in a material chapter."""

from datetime import datetime

from pydantic import BaseModel, Field

from app.provenance_schemas import MaterialProvenance


class MaterialChapterSegment(BaseModel):
    segment_id: str
    excerpt: str = Field(max_length=160)
    created_at: datetime
    material_provenance: MaterialProvenance


class MaterialChapterSegmentsResponse(BaseModel):
    items: list[MaterialChapterSegment]
    next_cursor: str | None
    unavailable_count: int = Field(ge=0)
