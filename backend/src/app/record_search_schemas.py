"""Book-local saved record discovery, separate from original text matches."""

from typing import Literal

from pydantic import BaseModel

from app.material_schemas import PositionAnchor
from app.provenance_schemas import MaterialProvenance

RecordSearchKind = Literal["segment", "translation", "bookmark"]


class MaterialRecordSearchItem(BaseModel):
    kind: RecordSearchKind
    id: str
    chapter_id: str | None = None
    chapter_title: str | None = None
    snippet: str
    source_excerpt: str | None = None
    position: PositionAnchor | None = None
    material_provenance: MaterialProvenance | None = None
    segment_id: str | None = None
    result_id: str | None = None
    bookmark_id: str | None = None
    identity_sha256: str | None = None


class MaterialRecordSearchResponse(BaseModel):
    material_id: str
    version_id: str
    query: str
    kind: RecordSearchKind
    total: int
    offset: int
    limit: int
    items: list[MaterialRecordSearchItem]
