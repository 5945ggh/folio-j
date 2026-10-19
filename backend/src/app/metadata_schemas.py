"""Editable book presentation contracts; EPUB content stays immutable."""

import unicodedata
from typing import Literal, Self

from pydantic import Field, field_validator, model_validator

from app.catalog_schemas import MaterialCatalogItem
from app.schemas import StrictInput


class MaterialDetailsResponse(MaterialCatalogItem):
    original_title: str
    chapter_count: int
    metadata_revision: int
    custom_cover: bool


class MaterialCoverInput(StrictInput):
    media_type: Literal["image/png", "image/jpeg"]
    data_base64: str = Field(max_length=5_592_408)


class MaterialMetadataUpdate(StrictInput):
    title: str
    expected_revision: int = Field(ge=0, strict=True)
    cover_action: Literal["keep", "replace", "reset"] = "keep"
    cover: MaterialCoverInput | None = None

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str) -> str:
        value = unicodedata.normalize("NFC", value.strip())
        if not value or len(value) > 300:
            raise ValueError("书名须为 1–300 字符")
        return value

    @model_validator(mode="after")
    def validate_cover_action(self) -> Self:
        if (self.cover_action == "replace") != (self.cover is not None):
            raise ValueError("只有替换封面时必须提供图片")
        return self
