"""EPUB input and chapter projections over complete text analysis assets."""

from fastapi import HTTPException

from app.epub_schemas import CompiledBook
from app.nlp.assets import decode
from app.nlp.contracts import MaterialResourceReadings, TextResource


def text_resources(book: CompiledBook) -> list[TextResource]:
    """Retain spine order and repeated resource occurrences."""
    return [TextResource(r.id, r.text, r.text_sha256) for r in book.resources]


def chapter_resources(
    payload: bytes,
    book: CompiledBook,
    chapter_id: str,
) -> list[MaterialResourceReadings]:
    chapter = next((c for c in book.chapters if c.id == chapter_id), None)
    if chapter is None:
        raise HTTPException(404, "章节不存在")
    readings = decode(payload, text_resources(book))
    result: list[MaterialResourceReadings] = []
    for resource in readings.resources:
        parts = [p for p in chapter.parts if p.resource_id == resource.resource_id]
        if not parts:
            continue
        result.append(
            resource.model_copy(
                update={
                    "tokens": [
                        token
                        for token in resource.tokens
                        if any(token.start < p.end and token.end > p.start for p in parts)
                    ]
                }
            )
        )
    return result
