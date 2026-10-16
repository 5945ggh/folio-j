"""Current chapter position from immutable canonical codepoint ranges."""

import unicodedata
from functools import lru_cache
from html.parser import HTMLParser

from app.epub_schemas import CompiledBook
from app.material_schemas import PositionAnchor


class _ImagePrefix(HTMLParser):
    """Read only compiler-owned locator leaves before one image in a part."""

    def __init__(self, image_id: int) -> None:
        super().__init__(convert_charrefs=True)
        self.image_id = str(image_id)
        self.leaf = False
        self.text: list[str] = []
        self.image_offset: int | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self.image_offset is not None:
            return
        attributes = dict(attrs)
        if tag == "span" and "data-locator-leaf" in attributes:
            self.leaf = True
        if tag == "img" and attributes.get("data-epub-image") == self.image_id:
            # Normalize the whole raw prefix, including combinations across leaves.
            # A composition spanning the image is counted from its prefix alone,
            # matching the reader's projection rather than requiring a text anchor.
            self.image_offset = len(unicodedata.normalize("NFC", "".join(self.text)))

    def handle_endtag(self, tag: str) -> None:
        if tag == "span":
            self.leaf = False

    def handle_data(self, data: str) -> None:
        if self.leaf and self.image_offset is None:
            self.text.append(data)


@lru_cache(maxsize=8)
def _image_offset(markup: str, image_id: int) -> int:
    parser = _ImagePrefix(image_id)
    parser.feed(markup)
    return parser.image_offset or 0


def chapter_progress(book: CompiledBook, anchor: PositionAnchor) -> float | None:
    """Count part spans and image prefixes; image-only chapters have no ratio."""
    chapter = next((chapter for chapter in book.chapters if chapter.id == anchor.chapter_id), None)
    if chapter is None or anchor.part_index >= len(chapter.parts):
        return None
    resources = {resource.id: resource.text for resource in book.resources}
    if not any(
        resources[part.resource_id][part.start : part.end].strip() for part in chapter.parts
    ):
        return None
    total = sum(part.end - part.start for part in chapter.parts)
    if total <= 0:
        return None
    before = sum(part.end - part.start for part in chapter.parts[: anchor.part_index])
    part = chapter.parts[anchor.part_index]
    if anchor.kind == "text" and anchor.offset is not None:
        local = anchor.offset - part.start
    elif anchor.kind == "image" and anchor.image_id is not None:
        local = min(part.end - part.start, _image_offset(part.html, anchor.image_id))
    else:
        local = 0
    return max(0.0, min(1.0, (before + local) / total))
