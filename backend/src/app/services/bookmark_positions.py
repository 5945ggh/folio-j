"""Pure canonical excerpt and book-order projection behind ReaderViews."""

import unicodedata
from dataclasses import dataclass
from html.parser import HTMLParser

from fastapi import HTTPException

from app.epub_schemas import CompiledBook
from app.material_schemas import PositionAnchor

BEFORE_CODEPOINTS = 40
AFTER_CODEPOINTS = 120


@dataclass(frozen=True)
class BookmarkLocation:
    chapter_title: str
    excerpt: str
    chapter_index: int
    position_offset: int
    position_order: int


class _Images(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.text: list[str] = []
        self.leaf = False
        self.images: list[tuple[str, int, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "span" and "data-locator-leaf" in attributes:
            self.leaf = True
        if tag == "img" and attributes.get("data-epub-image") is not None:
            self.images.append(
                (
                    attributes["data-epub-image"] or "",
                    len(unicodedata.normalize("NFC", "".join(self.text))),
                    attributes.get("alt") or "",
                )
            )

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag: str) -> None:
        if tag == "span":
            self.leaf = False

    def handle_data(self, data: str) -> None:
        if self.leaf:
            self.text.append(data)


def project_bookmark(book: CompiledBook, position: PositionAnchor) -> BookmarkLocation:
    """Use canonical text only; clip to this chapter, including adjacent parts."""
    chapter_index, chapter = next(
        (index, chapter)
        for index, chapter in enumerate(book.chapters)
        if chapter.id == position.chapter_id
    )
    part = chapter.parts[position.part_index]
    parser = _Images()
    parser.feed(part.html)
    alt = ""
    if position.kind == "image":
        matching = [
            (index, offset, text)
            for index, (image_id, offset, text) in enumerate(parser.images)
            if image_id == str(position.image_id)
        ]
        if len(matching) != 1:
            raise HTTPException(422, "图片位置无法精确确认")
        image_index, local_offset, alt = matching[0]
        offset = min(part.end, part.start + local_offset)
        order = image_index
    else:
        assert position.offset is not None
        offset = position.offset
        order = len(parser.images)
    resources = {resource.id: resource.text for resource in book.resources}
    # Slice only the fixed budget; no full chapter text copy is necessary.
    text = resources[part.resource_id]
    before = text[max(part.start, offset - BEFORE_CODEPOINTS) : offset]
    after = text[offset : min(part.end, offset + AFTER_CODEPOINTS)]
    for previous in reversed(chapter.parts[: position.part_index]):
        remaining = BEFORE_CODEPOINTS - len(before)
        if remaining <= 0:
            break
        before = (
            resources[previous.resource_id][
                max(previous.start, previous.end - remaining) : previous.end
            ]
            + before
        )
    for following in chapter.parts[position.part_index + 1 :]:
        remaining = AFTER_CODEPOINTS - len(after)
        if remaining <= 0:
            break
        after += resources[following.resource_id][
            following.start : min(following.end, following.start + remaining)
        ]
    excerpt = " ".join((before + after).split())
    if not excerpt and alt:
        excerpt = unicodedata.normalize("NFC", " ".join(alt.split()))[
            : BEFORE_CODEPOINTS + AFTER_CODEPOINTS
        ]
    return BookmarkLocation(chapter.title, excerpt, chapter_index, offset, order)
