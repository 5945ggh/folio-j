"""Frozen reader measurement control copied from commit 7747434d1a3622a65c583efa1eec4f7f4df5c7a2.

This benchmark-only module preserves the three pre-ReaderViews service flows,
including both compiled-BLOB SELECTs in position PUT and full-book NLP decoding.
It never runs in production. Models, EPUB/NLP decoders, chapter_resources,
chapter_progress and transaction/time helpers are shared with the application;
the measured query/control/scan flows below remain frozen at the named revision.
The local import in the original get_readings is removed to bind these frozen
bundle/require_material functions instead of production implementations.
"""

import asyncio
import base64
import binascii
import re
from collections.abc import Iterator
from html.parser import HTMLParser

from app.epub_schemas import ChapterPart, CompiledBook, CompiledChapter
from app.epub_storage import decode as decode_epub
from app.material_models import (
    ChapterReadingPosition,
    Material,
    MaterialReadingsCurrent,
    MaterialReadingsGeneration,
    ReadingPosition,
)
from app.material_schemas import (
    PositionAnchor,
    ReadingPositionResponse,
    ReadingPositionUpdate,
)
from app.models import Source
from app.readings_schemas import MaterialReadingsResponse
from app.services.epub import MAX_PRODUCT_BYTES
from app.services.epub_readings import chapter_resources
from app.services.position_progress import chapter_progress
from app.services.sources import begin_write, utc_now
from fastapi import HTTPException, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

BASELINE_REVISION = "7747434d1a3622a65c583efa1eec4f7f4df5c7a2"


def bundle(material: Material) -> CompiledBook:
    return decode_epub(material.compiled_bundle)


async def require_material(
    session: AsyncSession, material_id: str, *, with_bundle: bool = True
) -> Material:
    statement = (
        select(Material)
        .join(Source, Material.source_id == Source.id)
        .where(
            Material.id == material_id,
            Material.deleted_at.is_(None),
            Source.deleted_at.is_(None),
        )
    )
    if not with_bundle:
        statement = statement.options(defer(Material.compiled_bundle))
    material = await session.scalar(statement)
    if material is None:
        raise HTTPException(404, "材料不存在")
    return material


async def save_position(
    session: AsyncSession, material_id: str, data: ReadingPositionUpdate
) -> ReadingPositionResponse:
    try:
        material = await require_material(session, material_id)
        book = await asyncio.to_thread(bundle, material)
        chapter = next((c for c in book.chapters if c.id == data.chapter_id), None)
        if (
            data.version_id != material.version_id
            or chapter is None
            or data.part_index >= len(chapter.parts)
        ):
            raise HTTPException(422, "位置版本或章节无效")
        part = chapter.parts[data.part_index]
        if part.resource_id != data.resource_id:
            raise HTTPException(422, "位置资源不属于章节")
        if data.kind == "text" and (
            data.offset is None or not part.start <= data.offset <= part.end
        ):
            raise HTTPException(422, "正文偏移超出章节范围")
        if data.kind == "image" and str(data.image_id) not in re.findall(
            r'data-epub-image=["\'](\d+)["\']', part.html
        ):
            raise HTTPException(422, "图片不属于章节")
        await session.rollback()
        await begin_write(session)
        material = await require_material(session, material_id)
        if material.version_id != data.version_id:
            raise HTTPException(422, "位置版本无效")
        position = await session.get(ReadingPosition, material_id)
        revision = position.revision if position else 0
        if data.expected_revision != revision:
            raise HTTPException(409, "阅读位置已更新，请重新读取")
        anchor = PositionAnchor.model_validate(
            data.model_dump(exclude={"expected_revision"})
        )
        now = utc_now()
        if position is None:
            position = ReadingPosition(
                material_id=material_id,
                revision=revision + 1,
                payload=anchor.model_dump_json(),
                updated_at=now,
            )
            session.add(position)
        else:
            position.revision += 1
            position.payload = anchor.model_dump_json()
            position.updated_at = now
        chapter_position = await session.get(
            ChapterReadingPosition, (material_id, data.chapter_id)
        )
        if chapter_position is None:
            chapter_position = ChapterReadingPosition(
                material_id=material_id, chapter_id=data.chapter_id
            )
            session.add(chapter_position)
        chapter_position.revision = position.revision
        chapter_position.payload = anchor.model_dump_json()
        chapter_position.updated_at = now
        result = ReadingPositionResponse(
            **anchor.model_dump(),
            revision=position.revision,
            updated_at=now,
            progress=chapter_progress(book, anchor),
        )
        await session.commit()
        return result
    except BaseException:
        await session.rollback()
        raise


async def current(
    session: AsyncSession, material: Material
) -> MaterialReadingsGeneration | None:
    asset = await session.scalar(
        select(MaterialReadingsGeneration)
        .join(
            MaterialReadingsCurrent,
            MaterialReadingsCurrent.generation_id == MaterialReadingsGeneration.id,
        )
        .where(
            MaterialReadingsCurrent.material_id == material.id,
            MaterialReadingsGeneration.version_id == material.version_id,
        )
    )
    return asset


async def get_readings(
    session: AsyncSession,
    material_id: str,
    version_id: str,
    chapter_id: str,
    generation_id: str | None = None,
) -> MaterialReadingsResponse:
    material = await require_material(session, material_id)
    if version_id != material.version_id:
        raise HTTPException(409, "材料版本已改变")
    active = (
        await session.scalar(
            select(MaterialReadingsGeneration).where(
                MaterialReadingsGeneration.id == generation_id,
                MaterialReadingsGeneration.material_id == material_id,
                MaterialReadingsGeneration.version_id == version_id,
            )
        )
        if generation_id is not None
        else await current(session, material)
    )
    if active is None:
        if generation_id is not None:
            raise HTTPException(404, "注音代次不存在")
        raise HTTPException(409, "注音尚未准备，请调用准备接口后重试")
    generation_id, payload = active.id, active.payload
    book = await asyncio.to_thread(bundle, material)
    resources = await asyncio.to_thread(chapter_resources, payload, book, chapter_id)
    return MaterialReadingsResponse(
        material_id=material_id,
        version_id=version_id,
        generation_id=generation_id,
        resources=resources,
    )


async def _material(
    session: AsyncSession, material_id: str, version_id: str
) -> Material:
    material = await require_material(session, material_id)
    if material.version_id != version_id:
        raise HTTPException(409, "材料版本已变更，请重新打开")
    return material


class _Images(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.items: list[tuple[int, str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "img":
            return
        attributes = dict(attrs)
        image_id = attributes.get("data-epub-image", "") or ""
        source = attributes.get("src", "") or ""
        if (
            image_id.isascii()
            and image_id.isdecimal()
            and source.startswith(
                (
                    "data:image/png;base64,",
                    "data:image/jpeg;base64,",
                    "data:image/gif;base64,",
                    "data:image/webp;base64,",
                )
            )
        ):
            self.items.append((int(image_id), attributes.get("alt", "") or "", source))

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)


def _images(
    book: CompiledBook,
) -> Iterator[tuple[CompiledChapter, int, ChapterPart, int, str, str]]:
    for chapter in book.chapters:
        for index, part in enumerate(chapter.parts):
            parser = _Images()
            parser.feed(part.html)
            for image_id, alt, source in parser.items:
                yield chapter, index, part, image_id, alt, source


def _content(material: Material, ordinal: int) -> tuple[bytes, str]:
    for index, (_, _, _, _, _, source) in enumerate(_images(bundle(material))):
        if index != ordinal:
            continue
        header, encoded = source.split(",", 1)
        if len(encoded) > ((MAX_PRODUCT_BYTES + 2) // 3) * 4:
            raise HTTPException(413, "图片超过编译安全大小限制")
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise HTTPException(422, "图片数据损坏") from exc
        mime = header[5:].split(";", 1)[0]
        valid = (
            (mime == "image/png" and data.startswith(b"\x89PNG\r\n\x1a\n"))
            or (mime == "image/jpeg" and data.startswith(b"\xff\xd8\xff"))
            or (mime == "image/gif" and data.startswith((b"GIF87a", b"GIF89a")))
            or (
                mime == "image/webp"
                and data.startswith(b"RIFF")
                and data[8:12] == b"WEBP"
            )
        )
        if not valid or len(data) > MAX_PRODUCT_BYTES:
            raise HTTPException(422, "图片类型与内容不符")
        return data, mime
    raise HTTPException(404, "图片不存在")


async def illustration_content(
    session: AsyncSession,
    material_id: str,
    version_id: str,
    ordinal: int,
) -> Response:
    material = await _material(session, material_id, version_id)
    data, mime = await asyncio.to_thread(_content, material, ordinal)
    return Response(
        content=data,
        media_type=mime,
        headers={
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
        },
    )
