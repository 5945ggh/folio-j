"""Material API and optimistic resource-local reading positions."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.epub_schemas import ChapterPart
from app.schemas import StrictInput


class ReadingSettings(StrictInput):
    font_size: float = Field(default=20, ge=12, le=40)
    line_height: float = Field(default=1.8, ge=1, le=3)
    writing_mode: Literal["horizontal-tb", "vertical-rl"] = "horizontal-tb"


class PositionAnchor(StrictInput):
    version_id: str
    chapter_id: str
    part_index: int = Field(ge=0)
    resource_id: str
    kind: Literal["text", "image"]
    offset: int | None = Field(default=None, ge=0)
    image_id: int | None = Field(default=None, ge=0)
    image_progress: float | None = Field(default=None, ge=0, le=1)
    settings: ReadingSettings = Field(default_factory=ReadingSettings)

    @model_validator(mode="after")
    def valid_kind(self) -> "PositionAnchor":
        if self.kind == "text" and (
            self.offset is None or self.image_id is not None or self.image_progress is not None
        ):
            raise ValueError("文字位置须提供码点偏移")
        if self.kind == "image" and (
            self.image_id is None or self.image_progress is None or self.offset is not None
        ):
            raise ValueError("图片位置须提供图片索引和局部进度")
        return self


class ReadingPositionUpdate(PositionAnchor):
    expected_revision: int = Field(ge=0)


class ReadingPositionResponse(PositionAnchor):
    revision: int
    updated_at: datetime
    progress: float | None = Field(ge=0, le=1)


class MaterialSummary(BaseModel):
    id: str
    source_id: str
    title: str
    source_sha256: str
    version_id: str
    product_sha256: str
    contract_version: str
    created_at: datetime
    warnings: list[str]


class ChapterSummary(BaseModel):
    id: str
    title: str
    level: int
    part_count: int


class MaterialResponse(MaterialSummary):
    chapters: list[ChapterSummary]
    reading_position: ReadingPositionResponse | None
    chapter_positions: list[ReadingPositionResponse] = Field(
        default_factory=lambda: list[ReadingPositionResponse]()
    )


class MaterialImportResponse(BaseModel):
    material: MaterialResponse
    reused: bool


class ChapterResource(BaseModel):
    id: str
    href: str
    text: str
    css: str
    html_attributes: dict[str, str]
    body_attributes: dict[str, str]
    text_sha256: str


class MaterialChapterResponse(BaseModel):
    material_id: str
    version_id: str
    id: str
    title: str
    level: int
    parts: list[ChapterPart]
    resources: list[ChapterResource]


class MaterialSearchItem(BaseModel):
    chapter_id: str
    chapter_title: str
    part_index: int
    spine_index: int
    resource_id: str
    start: int
    end: int
    before: str
    match: str
    after: str


class MaterialSearchResponse(BaseModel):
    material_id: str
    version_id: str
    query: str
    total: int
    offset: int
    limit: int
    items: list[MaterialSearchItem]


class MaterialIllustrationItem(BaseModel):
    ordinal: int
    chapter_id: str
    chapter_title: str
    part_index: int
    spine_index: int
    resource_id: str
    image_id: int
    alt: str
    content_url: str


class MaterialIllustrationsResponse(BaseModel):
    material_id: str
    version_id: str
    total: int
    offset: int
    limit: int
    items: list[MaterialIllustrationItem]
