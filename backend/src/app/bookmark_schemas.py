"""User-owned return positions, separate from automatic reading history."""

import unicodedata
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from app.material_schemas import PositionAnchor
from app.schemas import StrictInput


class BookmarkCreate(StrictInput):
    request_id: UUID
    position: PositionAnchor
    allow_nearby: bool = False


class BookmarkUpdate(StrictInput):
    note: str = Field(max_length=5000)
    expected_revision: int = Field(ge=0)

    @field_validator("note", mode="before")
    @classmethod
    def normalize_note(cls, value: object) -> object:
        return unicodedata.normalize("NFC", value) if isinstance(value, str) else value


class BookmarkResponse(BaseModel):
    id: str
    material_id: str
    position: PositionAnchor
    chapter_title: str
    excerpt: str
    chapter_progress: float | None = Field(default=None, ge=0, le=1)
    note: str
    revision: int
    created_at: datetime
    updated_at: datetime


class BookmarkNearbyResponse(BaseModel):
    kind: Literal["nearby"]
    bookmark: BookmarkResponse


class BookmarksResponse(BaseModel):
    material_id: str
    version_id: str
    total: int
    offset: int
    limit: int
    items: list[BookmarkResponse]
