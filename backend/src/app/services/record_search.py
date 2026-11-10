"""Literal, read-only discovery of explicitly book-backed saved records."""

import asyncio
import unicodedata
from dataclasses import dataclass
from datetime import datetime

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import case, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.epub_schemas import CompiledBook
from app.epub_storage import decode as decode_epub
from app.material_models import MaterialBookmark
from app.material_schemas import PositionAnchor
from app.models import Segment, SegmentMaterialProvenance
from app.provenance_schemas import ASSEMBLY_RULE, MaterialProvenance
from app.record_search_schemas import (
    MaterialRecordSearchItem,
    MaterialRecordSearchResponse,
    RecordSearchKind,
)
from app.services.bookmark_positions import project_bookmark
from app.services.chapter_translations import Payload
from app.services.material_provenance import (
    ProvenanceError,
    identity_sha256,
    validate_reference,
)
from app.services.material_segments import MaterialIdentity
from app.services.materials import require_material
from app.services.reader_queries import selected_chapters
from app.translation_models import TranslationResult, TranslationTask


@dataclass(frozen=True)
class Candidate:
    id: str
    source_text: str
    translation: str
    note: str
    payload: str
    created_at: datetime
    digest: str = ""
    assembly_rule: str = ASSEMBLY_RULE


async def candidates(
    session: AsyncSession, identity: MaterialIdentity, kind: RecordSearchKind
) -> list[Candidate]:
    if kind == "segment":
        rows = (
            await session.execute(
                select(
                    Segment.id,
                    Segment.text,
                    Segment.translation,
                    Segment.note,
                    SegmentMaterialProvenance.payload,
                    Segment.created_at,
                    SegmentMaterialProvenance.identity_sha256,
                    SegmentMaterialProvenance.assembly_rule,
                )
                .join(SegmentMaterialProvenance, Segment.id == SegmentMaterialProvenance.segment_id)
                .where(
                    Segment.source_id == identity.source_id,
                    Segment.deleted_at.is_(None),
                    SegmentMaterialProvenance.source_id == identity.source_id,
                    SegmentMaterialProvenance.material_id == identity.id,
                    SegmentMaterialProvenance.version_id == identity.version_id,
                )
            )
        ).all()
        return [Candidate(*row) for row in rows]
    if kind == "translation":
        payload = case(
            (func.json_valid(TranslationTask.payload), TranslationTask.payload), else_="{}"
        )
        rows = (
            await session.execute(
                select(
                    TranslationResult.id,
                    TranslationTask.payload,
                    TranslationResult.translation,
                    TranslationResult.created_at,
                    TranslationTask.identity_sha256,
                )
                .join(TranslationTask, TranslationTask.id == TranslationResult.task_id)
                .where(
                    TranslationTask.material_id == identity.id,
                    TranslationTask.source_id == identity.source_id,
                    TranslationTask.status == "succeeded",
                    TranslationTask.reader_deleted_at.is_(None),
                    TranslationTask.result_id == TranslationResult.id,
                    func.json_extract(payload, "$.material_provenance.material_id") == identity.id,
                    func.json_extract(payload, "$.material_provenance.version_id")
                    == identity.version_id,
                )
            )
        ).all()
        return [
            Candidate(id, "", translation, "", payload, created, digest)
            for id, payload, translation, created, digest in rows
        ]
    rows = (
        await session.execute(
            select(
                MaterialBookmark.id,
                MaterialBookmark.excerpt,
                MaterialBookmark.note,
                MaterialBookmark.position,
                MaterialBookmark.created_at,
            ).where(
                MaterialBookmark.material_id == identity.id,
                MaterialBookmark.version_id == identity.version_id,
                MaterialBookmark.deleted_at.is_(None),
            )
        )
    ).all()
    return [
        Candidate(id, excerpt, "", note, position, created)
        for id, excerpt, note, position, created in rows
    ]


def _latest(rows: list[Candidate]) -> list[Candidate]:
    groups: dict[str, Candidate] = {}
    for row in rows:
        previous = groups.get(row.digest)
        if previous is None or (row.created_at, row.id) > (previous.created_at, previous.id):
            groups[row.digest] = row
    return list(groups.values())


def _snippet(fields: tuple[str, ...], query: str) -> tuple[str, int] | None:
    for index, field in enumerate(fields):
        normalized = unicodedata.normalize("NFC", field)
        found = normalized.find(query) if query else 0
        if found >= 0 and (query or normalized.strip()):
            start = max(0, found - min(40, max(0, 160 - len(query))))
            end = min(len(normalized), start + 160)
            return (
                ("…" if start else "")
                + normalized[start:end]
                + ("…" if end < len(normalized) else ""),
                index,
            )
    return ("", 0) if not query else None


def _bookmark_position(book: CompiledBook, payload: str, version_id: str) -> PositionAnchor:
    position = PositionAnchor.model_validate_json(payload)
    chapter = next((c for c in book.chapters if c.id == position.chapter_id), None)
    if (
        position.version_id != version_id
        or chapter is None
        or position.part_index >= len(chapter.parts)
    ):
        raise ProvenanceError("书签位置不属于当前版本")
    part = chapter.parts[position.part_index]
    if part.resource_id != position.resource_id or (
        position.kind == "text"
        and (position.offset is None or not part.start <= position.offset <= part.end)
    ):
        raise ProvenanceError("书签位置范围无效")
    return position


def scan_records(
    identity: MaterialIdentity,
    kind: RecordSearchKind,
    rows: list[Candidate],
    query: str,
    chapter_ids: list[str] | None,
) -> list[MaterialRecordSearchItem]:
    book = decode_epub(identity.compiled_bundle)
    if book.product_sha256 != identity.product_sha256 or book.contract != identity.contract_version:
        raise HTTPException(409, "材料版本产物身份不匹配")
    selected = selected_chapters(book, chapter_ids)
    chapters = {chapter.id: (index, chapter) for index, chapter in enumerate(book.chapters)}
    ordered: list[tuple[tuple[int, int, int, int, float, str], MaterialRecordSearchItem]] = []
    for row in _latest(rows) if kind == "translation" else rows:
        fields = (
            (row.translation,)
            if kind == "translation"
            else (row.source_text, row.translation, row.note)
        )
        selected_snippet = _snippet(fields, query)
        if selected_snippet is None:
            continue
        snippet, field_index = selected_snippet
        show_source = kind == "translation" or field_index > 0
        item = MaterialRecordSearchItem(
            kind=kind,
            id=row.id,
            snippet=snippet,
            source_excerpt=(row.source_text[:160] or None) if show_source else None,
            segment_id=row.id if kind == "segment" else None,
            result_id=row.id if kind == "translation" else None,
            bookmark_id=row.id if kind == "bookmark" else None,
            identity_sha256=row.digest if kind == "translation" else None,
        )
        sort_key = (len(book.chapters), 0, 0, 0, 0.0, row.id)
        try:
            if kind == "bookmark":
                position = _bookmark_position(book, row.payload, identity.version_id)
                location = project_bookmark(book, position)
                item.position = position
                sort_key = (
                    location.chapter_index,
                    position.part_index,
                    location.position_offset,
                    location.position_order,
                    position.image_progress or 0.0,
                    row.id,
                )
            else:
                payload = (
                    Payload.model_validate_json(row.payload) if kind == "translation" else None
                )
                reference = (
                    payload.material_provenance
                    if payload
                    else (MaterialProvenance.model_validate_json(row.payload))
                )
                if (
                    reference.material_id != identity.id
                    or reference.version_id != identity.version_id
                    or row.assembly_rule != ASSEMBLY_RULE
                ):
                    raise ProvenanceError("资料出处身份不匹配")
                normalized, original, chapter_id, parts = validate_reference(book, reference)
                if kind == "segment" and original != row.source_text:
                    raise ProvenanceError("片段与原文快照失配")
                if payload is not None and (
                    payload.text != original
                    or payload.chapter_id != chapter_id
                    or payload.parts != parts
                    or identity_sha256(normalized) != row.digest
                ):
                    raise ProvenanceError("译文与原文快照失配")
                first = parts[0]
                item.material_provenance = normalized
                item.source_excerpt = original[:160] if show_source else None
                item.position = PositionAnchor(
                    version_id=identity.version_id,
                    chapter_id=chapter_id,
                    part_index=first.part_index,
                    resource_id=first.resource_id,
                    kind="text",
                    offset=first.start,
                )
                sort_key = (chapters[chapter_id][0], first.part_index, first.start, 0, 0.0, row.id)
            item.chapter_id = item.position.chapter_id
            item.chapter_title = chapters[item.chapter_id][1].title
        except (ValidationError, ProvenanceError, HTTPException, ValueError, IndexError, KeyError):
            # An explicit material relation remains discoverable; it never licenses
            # guessing a replacement location from equal text elsewhere in the book.
            item.position = None
            item.material_provenance = None
            item.chapter_id = None
            item.chapter_title = None
        if selected is None or item.chapter_id in selected:
            ordered.append((sort_key, item))
    return [item for _, item in sorted(ordered, key=lambda pair: pair[0])]


async def search(
    session: AsyncSession,
    material_id: str,
    version_id: str,
    kind: RecordSearchKind,
    q: str,
    offset: int,
    limit: int,
    chapter_ids: list[str] | None = None,
) -> MaterialRecordSearchResponse:
    try:
        identity = MaterialIdentity.capture(await require_material(session, material_id))
        if identity.version_id != version_id:
            raise HTTPException(409, "材料版本已变更，请重新打开")
        rows = await candidates(session, identity, kind)
        query = unicodedata.normalize("NFC", q.strip())
        await session.rollback()
        items = await asyncio.to_thread(scan_records, identity, kind, rows, query, chapter_ids)
        # Re-open a coherent read snapshot after CPU work. Deletion or edits that
        # raced with the scan must not leak stale text or resurrect an older result.
        await session.execute(text("BEGIN"))
        session.expire_all()
        current = MaterialIdentity.capture(await require_material(session, material_id))
        if current != identity:
            raise HTTPException(409, "材料版本已变更，请重新打开")
        fresh = await candidates(session, identity, kind)
        visible = {row.id: row for row in (_latest(fresh) if kind == "translation" else fresh)}
        originals = {row.id: row for row in rows}
        items = [item for item in items if visible.get(item.id) == originals[item.id]]
        return MaterialRecordSearchResponse(
            material_id=material_id,
            version_id=version_id,
            query=query,
            kind=kind,
            total=len(items),
            offset=offset,
            limit=limit,
            items=items[offset : offset + limit],
        )
    finally:
        await session.rollback()
