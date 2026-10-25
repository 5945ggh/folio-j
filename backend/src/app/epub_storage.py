"""Lossless, bounded physical encoding of immutable compiled EPUB books."""

import base64
import binascii
import json
import re
import zlib
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

from app.epub_schemas import CompiledBook
from app.services.epub import MAX_PRODUCT_BYTES

_MAGIC = b"FJEPUB\x01"
_IMAGE = re.compile(r"data:image/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}")
_Fragment = str | Annotated[int, Field(strict=True, ge=0)]


class _StoredBook(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    book: CompiledBook
    resource_html: list[list[_Fragment]]
    chapter_html: list[list[list[_Fragment]]]
    images: list[str]


def _inflate(payload: bytes) -> bytes:
    limit = MAX_PRODUCT_BYTES * 2
    try:
        stream = zlib.decompressobj()
        raw = stream.decompress(payload, limit + 1)
    except zlib.error as exc:
        raise ValueError("编译包压缩数据无效") from exc
    if len(raw) > limit or stream.unconsumed_tail:
        raise ValueError("编译包超过解码预算")
    if not stream.eof or stream.unused_data:
        raise ValueError("编译包压缩数据不完整或含多余内容")
    return raw


def _valid_image(value: str) -> bool:
    if _IMAGE.fullmatch(value) is None:
        return False
    try:
        base64.b64decode(value.split(",", 1)[1], validate=True)
    except binascii.Error:
        return False
    return True


def encode(book: CompiledBook) -> bytes:
    """Write one versioned format, with an empty pool for books without images."""
    if len(book.model_dump_json().encode()) > MAX_PRODUCT_BYTES:
        raise ValueError("编译包超过编码预算")
    images: list[str] = []
    indices: dict[str, int] = {}

    def split(markup: str) -> list[_Fragment]:
        pieces: list[_Fragment] = []
        end = 0
        for match in _IMAGE.finditer(markup):
            image = match.group()
            if image not in indices:
                if not _valid_image(image):
                    continue
                indices[image] = len(images)
                images.append(image)
            pieces.extend((markup[end : match.start()], indices[image]))
            end = match.end()
        pieces.append(markup[end:])
        return pieces

    resource_html = [split(resource.html) for resource in book.resources]
    chapter_html = [[split(part.html) for part in chapter.parts] for chapter in book.chapters]
    skeleton = book.model_copy(
        update={
            "resources": [r.model_copy(update={"html": ""}) for r in book.resources],
            "chapters": [
                chapter.model_copy(
                    update={"parts": [p.model_copy(update={"html": ""}) for p in chapter.parts]}
                )
                for chapter in book.chapters
            ],
        }
    )
    stored = (
        _StoredBook(
            book=skeleton, resource_html=resource_html, chapter_html=chapter_html, images=images
        )
        .model_dump_json()
        .encode()
    )
    if len(stored) > MAX_PRODUCT_BYTES * 2:
        raise ValueError("编译包超过存储编码预算")
    return _MAGIC + zlib.compress(stored)


def decode(payload: bytes) -> CompiledBook:
    """Validate the versioned pool and restore the unchanged logical book."""
    if not payload.startswith(_MAGIC):
        raise ValueError("编译包存储版本不受支持")
    stored = _StoredBook.model_validate_json(_inflate(payload[len(_MAGIC) :]))
    book = stored.book
    if len(stored.resource_html) != len(book.resources) or len(stored.chapter_html) != len(
        book.chapters
    ):
        raise ValueError("编译包 HTML 数量与资源或章节不一致")
    for chapter, parts in zip(book.chapters, stored.chapter_html, strict=True):
        if len(parts) != len(chapter.parts):
            raise ValueError("编译包 HTML 数量与章节片段不一致")
    if any(r.html for r in book.resources) or any(p.html for c in book.chapters for p in c.parts):
        raise ValueError("编译包骨架含重复 HTML")
    if any(not _valid_image(image) for image in stored.images):
        raise ValueError("编译包图片池无效")

    # Count escaped JSON bytes across the whole book before allocating expanded HTML.
    # Image URIs are ASCII without JSON escapes; literal fragments may contain both.
    budget = len(book.model_dump_json().encode())
    if budget > MAX_PRODUCT_BYTES:
        raise ValueError("编译包还原结果超过解码预算")
    image_sizes = [len(image) for image in stored.images]
    all_html = [
        *stored.resource_html,
        *(parts for chapter in stored.chapter_html for parts in chapter),
    ]
    for pieces in all_html:
        for piece in pieces:
            if isinstance(piece, str):
                budget += len(json.dumps(piece, ensure_ascii=False).encode()) - 2
            else:
                if piece >= len(stored.images):
                    raise ValueError("编译包图片引用不存在")
                budget += image_sizes[piece]
            if budget > MAX_PRODUCT_BYTES:
                raise ValueError("编译包还原结果超过解码预算")

    def restore(pieces: list[_Fragment]) -> str:
        return "".join(
            piece if isinstance(piece, str) else stored.images[piece] for piece in pieces
        )

    return book.model_copy(
        update={
            "resources": [
                resource.model_copy(update={"html": restore(parts)})
                for resource, parts in zip(book.resources, stored.resource_html, strict=True)
            ],
            "chapters": [
                chapter.model_copy(
                    update={
                        "parts": [
                            part.model_copy(update={"html": restore(pieces)})
                            for part, pieces in zip(chapter.parts, parts, strict=True)
                        ]
                    }
                )
                for chapter, parts in zip(book.chapters, stored.chapter_html, strict=True)
            ],
        }
    )
