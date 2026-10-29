"""Read-only queries over immutable compiled books; CPU work runs off the event loop."""

import asyncio
import unicodedata
from collections.abc import Iterator
from html.parser import HTMLParser
from typing import TYPE_CHECKING
from urllib.parse import quote

from fastapi import HTTPException, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.epub_schemas import ChapterPart, CompiledBook, CompiledChapter
from app.material_models import Material
from app.material_schemas import (
    MaterialIllustrationItem,
    MaterialIllustrationsResponse,
    MaterialSearchItem,
    MaterialSearchResponse,
)
from app.services.epub import MAX_PRODUCT_BYTES as MAX_PRODUCT_BYTES
from app.services.materials import bundle, require_material

if TYPE_CHECKING:
    from app.services.reader_views import ReaderViews


async def _material(session: AsyncSession, material_id: str, version_id: str) -> Material:
    material = await require_material(session, material_id)
    if material.version_id != version_id:
        raise HTTPException(409, "材料版本已变更，请重新打开")
    return material


def _ranges(chapter: CompiledChapter) -> Iterator[list[tuple[int, ChapterPart]]]:
    group: list[tuple[int, ChapterPart]] = []
    for index, part in enumerate(chapter.parts):
        if group:
            previous = group[-1][1]
            if (
                previous.resource_id != part.resource_id
                or previous.spine_index != part.spine_index
                or previous.end != part.start
            ):
                yield group
                group = []
        group.append((index, part))
    if group:
        yield group


def scan_search(material: Material, query: str, offset: int, limit: int) -> MaterialSearchResponse:
    items: list[MaterialSearchItem] = []
    total = 0
    if query:
        book = bundle(material)
        resources = {resource.id: resource for resource in book.resources}
        for chapter in book.chapters:
            for group in _ranges(chapter):
                first, last = group[0][1], group[-1][1]
                text = resources[first.resource_id].text
                cursor = first.start
                while True:
                    start = text.find(query, cursor, last.end)
                    if start < 0:
                        break
                    end = start + len(query)
                    if offset <= total < offset + limit:
                        index, part = next((i, p) for i, p in group if p.start <= start < p.end)
                        items.append(
                            MaterialSearchItem(
                                chapter_id=chapter.id,
                                chapter_title=chapter.title,
                                part_index=index,
                                spine_index=part.spine_index,
                                resource_id=part.resource_id,
                                start=start,
                                end=end,
                                before=text[max(first.start, start - 40) : start],
                                match=text[start:end],
                                after=text[end : min(last.end, end + 40)],
                            )
                        )
                    total += 1
                    cursor = start + 1
    return MaterialSearchResponse(
        material_id=material.id,
        version_id=material.version_id,
        query=query,
        total=total,
        offset=offset,
        limit=limit,
        items=items,
    )


async def search(
    session: AsyncSession,
    material_id: str,
    version_id: str,
    q: str,
    offset: int,
    limit: int,
) -> MaterialSearchResponse:
    material = await _material(session, material_id, version_id)
    query = unicodedata.normalize("NFC", q.strip())
    return await asyncio.to_thread(scan_search, material, query, offset, limit)


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


def scan_illustrations(
    material: Material, offset: int, limit: int
) -> MaterialIllustrationsResponse:
    items: list[MaterialIllustrationItem] = []
    total = 0
    for ordinal, (chapter, index, part, image_id, alt, _) in enumerate(_images(bundle(material))):
        total += 1
        if offset <= ordinal < offset + limit:
            items.append(
                MaterialIllustrationItem(
                    ordinal=ordinal,
                    chapter_id=chapter.id,
                    chapter_title=chapter.title,
                    part_index=index,
                    spine_index=part.spine_index,
                    resource_id=part.resource_id,
                    image_id=image_id,
                    alt=alt,
                    content_url=f"/api/materials/{quote(material.id, safe='')}/illustrations/"
                    f"{ordinal}/content?version_id={quote(material.version_id, safe='')}",
                )
            )
    return MaterialIllustrationsResponse(
        material_id=material.id,
        version_id=material.version_id,
        total=total,
        offset=offset,
        limit=limit,
        items=items,
    )


def scan_illustration_location(
    material: Material, chapter_id: str, part_index: int, image_id: int
) -> MaterialIllustrationsResponse:
    found: MaterialIllustrationItem | None = None
    total = 0
    for ordinal, (chapter, index, part, candidate, alt, _) in enumerate(_images(bundle(material))):
        total += 1
        if chapter.id == chapter_id and index == part_index and candidate == image_id:
            found = MaterialIllustrationItem(
                ordinal=ordinal,
                chapter_id=chapter.id,
                chapter_title=chapter.title,
                part_index=index,
                spine_index=part.spine_index,
                resource_id=part.resource_id,
                image_id=candidate,
                alt=alt,
                content_url=f"/api/materials/{quote(material.id, safe='')}/illustrations/"
                f"{ordinal}/content?version_id={quote(material.version_id, safe='')}",
            )
    if found is None:
        raise HTTPException(404, "该图已不可用")
    return MaterialIllustrationsResponse(
        material_id=material.id,
        version_id=material.version_id,
        total=total,
        offset=found.ordinal,
        limit=1,
        items=[found],
    )


async def illustrations(
    session: AsyncSession,
    material_id: str,
    version_id: str,
    offset: int,
    limit: int,
) -> MaterialIllustrationsResponse:
    material = await _material(session, material_id, version_id)
    return await asyncio.to_thread(scan_illustrations, material, offset, limit)


async def locate_illustration(
    session: AsyncSession,
    material_id: str,
    version_id: str,
    chapter_id: str,
    part_index: int,
    image_id: int,
) -> MaterialIllustrationsResponse:
    material = await _material(session, material_id, version_id)
    return await asyncio.to_thread(
        scan_illustration_location, material, chapter_id, part_index, image_id
    )


async def illustration_content(
    session: AsyncSession,
    material_id: str,
    version_id: str,
    ordinal: int,
    *,
    reader_views: "ReaderViews",
) -> Response:
    data, mime = await reader_views.image_content(material_id, version_id, ordinal)
    return Response(
        content=data,
        media_type=mime,
        headers={
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
        },
    )
