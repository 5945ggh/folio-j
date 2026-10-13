"""Current chapter position from immutable canonical codepoint ranges."""

from app.epub_schemas import CompiledBook
from app.material_schemas import PositionAnchor


def chapter_progress(book: CompiledBook, anchor: PositionAnchor) -> float | None:
    """Count part occurrences including whitespace; image-only chapters have no ratio."""
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
    local = (
        (anchor.offset - part.start) if anchor.kind == "text" and anchor.offset is not None else 0
    )
    return max(0.0, min(1.0, (before + local) / total))
