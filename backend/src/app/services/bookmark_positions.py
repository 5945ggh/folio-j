"""Pure canonical excerpt and book-order projection behind ReaderViews."""

import unicodedata
from dataclasses import dataclass
from html.parser import HTMLParser

from fastapi import HTTPException

from app.epub_schemas import CompiledBook
from app.material_schemas import PositionAnchor

EXCERPT_CODEPOINTS = 120
BEFORE_CODEPOINTS = EXCERPT_CODEPOINTS
AFTER_CODEPOINTS = EXCERPT_CODEPOINTS
NEARBY_CODEPOINTS = 24
NEARBY_IMAGE_PROGRESS = 0.05
# Match context-sentences-v1 in frontend/src/materials/study-context.ts.
SENTENCE_ENDS = frozenset("。！？!?")
SENTENCE_CLOSERS = frozenset("」』）)]】〉》”’")
SENTENCE_BOUNDARIES = SENTENCE_ENDS | frozenset("\r\n")
COMMA_BOUNDARIES = frozenset("、，,；;：:")


@dataclass(frozen=True)
class BookmarkLocation:
    chapter_title: str
    excerpt: str
    chapter_index: int
    position_offset: int
    position_order: int
    nearby_start: int
    nearby_end: int


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


def _excerpt(text: str, point: int, *, clipped_before: bool, clipped_after: bool) -> str:
    """Choose the containing sentence, then commas, within the complete budget."""
    if not text.strip():
        return ""
    probe = min(point, len(text) - 1)
    if text[probe].isspace():
        following = next(
            (index for index in range(probe, len(text)) if not text[index].isspace()), None
        )
        probe = (
            following
            if following is not None
            else max(index for index in range(probe + 1) if not text[index].isspace())
        )
    # End positions and closing quotes belong to the preceding nonempty sentence.
    while probe > 0 and text[probe] in SENTENCE_ENDS | SENTENCE_CLOSERS:
        probe -= 1
    start = max(
        (index + 1 for index, char in enumerate(text[:probe]) if char in SENTENCE_BOUNDARIES),
        default=0,
    )
    while start < probe and text[start] in SENTENCE_ENDS | SENTENCE_CLOSERS:
        start += 1
    end = next(
        (index + 1 for index in range(probe, len(text)) if text[index] in SENTENCE_BOUNDARIES),
        len(text),
    )
    while end < len(text) and text[end] in SENTENCE_ENDS | SENTENCE_CLOSERS:
        end += 1
    sentence_start, sentence_end = start, end
    prefix = start == 0 and clipped_before
    suffix = end == len(text) and clipped_after
    if end - start + int(prefix) + int(suffix) > EXCERPT_CODEPOINTS:
        start = max(start, probe - 40)
        commas = [index + 1 for index in range(start, probe) if text[index] in COMMA_BOUNDARIES]
        if commas:
            start = commas[-1]
        prefix = start > sentence_start or (start == 0 and clipped_before)
        end = min(sentence_end, start + EXCERPT_CODEPOINTS - int(prefix) - 1)
        commas = [index + 1 for index in range(probe + 1, end) if text[index] in COMMA_BOUNDARIES]
        if commas:
            end = commas[-1]
        suffix = end < sentence_end or (end == len(text) and clipped_after)
    body = " ".join(text[start:end].split())
    return ("…" if prefix else "") + body + ("…" if suffix else "") if body else ""


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
    text = resources[part.resource_id]
    before = text[max(part.start, offset - BEFORE_CODEPOINTS) : offset]
    after = text[offset : min(part.end, offset + AFTER_CODEPOINTS)]
    chapter_before = offset - part.start
    chapter_after = part.end - offset
    for previous in reversed(chapter.parts[: position.part_index]):
        chapter_before += previous.end - previous.start
        remaining = BEFORE_CODEPOINTS - len(before)
        if remaining > 0:
            before = (
                resources[previous.resource_id][
                    max(previous.start, previous.end - remaining) : previous.end
                ]
                + before
            )
    for following in chapter.parts[position.part_index + 1 :]:
        chapter_after += following.end - following.start
        remaining = AFTER_CODEPOINTS - len(after)
        if remaining > 0:
            after += resources[following.resource_id][
                following.start : min(following.end, following.start + remaining)
            ]
    excerpt = _excerpt(
        before + after,
        len(before),
        clipped_before=chapter_before > len(before),
        clipped_after=chapter_after > len(after),
    )
    if not excerpt and alt:
        excerpt = unicodedata.normalize("NFC", " ".join(alt.split()))
        if len(excerpt) > EXCERPT_CODEPOINTS:
            excerpt = excerpt[: EXCERPT_CODEPOINTS - 1] + "…"
    nearby_start = max(part.start, offset - NEARBY_CODEPOINTS)
    nearby_end = min(part.end, offset + NEARBY_CODEPOINTS)
    for index in range(nearby_start, offset):
        if text[index] in SENTENCE_BOUNDARIES:
            nearby_start = index + 1
    nearby_end = next(
        (index for index in range(offset, nearby_end) if text[index] in SENTENCE_BOUNDARIES),
        nearby_end,
    )
    return BookmarkLocation(
        chapter.title,
        excerpt,
        chapter_index,
        offset,
        order,
        nearby_start,
        nearby_end,
    )


def nearby_distance(
    position: PositionAnchor, existing: PositionAnchor, location: BookmarkLocation
) -> float | None:
    """Compare identity and canonical distance; repeated strings have no role."""
    if (
        position.version_id,
        position.chapter_id,
        position.part_index,
        position.resource_id,
        position.kind,
    ) != (
        existing.version_id,
        existing.chapter_id,
        existing.part_index,
        existing.resource_id,
        existing.kind,
    ):
        return None
    if position.kind == "image":
        if position.image_id != existing.image_id:
            return None
        assert position.image_progress is not None and existing.image_progress is not None
        distance = abs(position.image_progress - existing.image_progress)
        return distance if distance <= NEARBY_IMAGE_PROGRESS + 1e-9 else None
    assert position.offset is not None and existing.offset is not None
    if not location.nearby_start <= existing.offset <= location.nearby_end:
        return None
    return abs(position.offset - existing.offset)
