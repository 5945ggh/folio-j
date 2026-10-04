"""Immutable compiled EPUB reading contract; offsets use resource-local codepoints."""

from pydantic import BaseModel, ConfigDict


class EpubModel(BaseModel):
    model_config = ConfigDict(frozen=True)


class CompiledResource(EpubModel):
    id: str
    href: str
    title: str
    text: str
    html: str
    css: str
    html_attributes: dict[str, str]
    body_attributes: dict[str, str]
    text_sha256: str


class ChapterPart(EpubModel):
    resource_id: str
    spine_index: int
    start: int
    end: int
    html: str
    leaf_start: int
    leaf_end: int


class CompiledChapter(EpubModel):
    id: str
    title: str
    level: int
    parts: list[ChapterPart]


class CompiledBook(EpubModel):
    contract: str
    title: str
    warnings: list[str]
    resources: list[CompiledResource]
    chapters: list[CompiledChapter]
    product_sha256: str
