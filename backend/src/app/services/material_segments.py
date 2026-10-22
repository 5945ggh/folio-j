"""Keyset scanning with strict snapshots, one book decode and fresh visibility gates."""

import asyncio
import zlib
from dataclasses import dataclass
from datetime import datetime

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.epub_schemas import CompiledBook
from app.material_models import Material
from app.material_segment_schemas import MaterialChapterSegment, MaterialChapterSegmentsResponse
from app.models import Segment, SegmentMaterialProvenance
from app.provenance_schemas import ASSEMBLY_RULE, MaterialProvenance
from app.services.material_provenance import ProvenanceError, failure, validate_reference
from app.services.materials import require_material
from app.services.sources import as_utc


@dataclass(frozen=True)
class MaterialIdentity:
    id: str
    source_id: str
    version_id: str
    product_sha256: str
    contract_version: str
    compiled_bundle: bytes

    @classmethod
    def capture(cls, material: Material) -> "MaterialIdentity":
        return cls(
            material.id,
            material.source_id,
            material.version_id,
            material.product_sha256,
            material.contract_version,
            material.compiled_bundle,
        )


@dataclass(frozen=True)
class Candidate:
    segment_id: str
    source_id: str
    text: str
    created_at: datetime
    origin_source_id: str
    material_id: str
    version_id: str
    payload: str
    assembly_rule: str


async def candidates(
    session: AsyncSession,
    identity: MaterialIdentity,
    *,
    after: str | None = None,
    limit: int | None = None,
    ids: list[str] | None = None,
) -> list[Candidate]:
    statement = (
        select(
            Segment.id,
            Segment.source_id,
            Segment.text,
            Segment.created_at,
            SegmentMaterialProvenance.source_id,
            SegmentMaterialProvenance.material_id,
            SegmentMaterialProvenance.version_id,
            SegmentMaterialProvenance.payload,
            SegmentMaterialProvenance.assembly_rule,
        )
        .join(SegmentMaterialProvenance, Segment.id == SegmentMaterialProvenance.segment_id)
        .where(
            SegmentMaterialProvenance.material_id == identity.id,
            Segment.source_id == identity.source_id,
            Segment.deleted_at.is_(None),
        )
        .order_by(Segment.id)
    )
    if after is not None:
        statement = statement.where(Segment.id > after)
    if ids is not None:
        statement = statement.where(Segment.id.in_(ids))
    if limit is not None:
        statement = statement.limit(limit)
    rows = (await session.execute(statement)).all()
    return [Candidate(*row) for row in rows]


def validate_page(
    identity: MaterialIdentity, chapter_id: str, rows: list[Candidate]
) -> dict[str, tuple[MaterialChapterSegment | None, bool]]:
    """Decode once outside any database transaction, then validate each fixed candidate."""
    try:
        book = CompiledBook.model_validate_json(zlib.decompress(identity.compiled_bundle))
    except (ValueError, zlib.error) as exc:
        raise failure("material_unavailable", "材料版本产物不可用，请重新打开材料。", 409) from exc
    if book.product_sha256 != identity.product_sha256 or book.contract != identity.contract_version:
        raise failure("material_unavailable", "材料版本产物身份不匹配。", 409)
    if not any(chapter.id == chapter_id for chapter in book.chapters):
        raise failure("not_found", "章节不存在。", 404)
    result: dict[str, tuple[MaterialChapterSegment | None, bool]] = {}
    for row in rows:
        try:
            reference = MaterialProvenance.model_validate_json(row.payload)
            if (
                row.origin_source_id != identity.source_id
                or row.assembly_rule != ASSEMBLY_RULE
                or row.version_id != identity.version_id
                or reference.material_id != identity.id
                or reference.version_id != identity.version_id
            ):
                raise ProvenanceError("持久出处身份不匹配")
            normalized, text, resolved_chapter, _parts = validate_reference(book, reference)
            if row.text != text:
                raise ProvenanceError("片段原文与出处快照不匹配")
        except (ValidationError, ProvenanceError):
            result[row.segment_id] = (None, True)
            continue
        item = (
            MaterialChapterSegment(
                segment_id=row.segment_id,
                excerpt=row.text[:160],
                created_at=as_utc(row.created_at),
                material_provenance=normalized,
            )
            if resolved_chapter == chapter_id
            else None
        )
        result[row.segment_id] = (item, False)
    return result


async def list_chapter_segments(
    session: AsyncSession,
    material_id: str,
    chapter_id: str,
    version_id: str,
    after: str | None,
    limit: int,
) -> MaterialChapterSegmentsResponse:
    try:
        identity = MaterialIdentity.capture(await require_material(session, material_id))
        if identity.version_id != version_id:
            raise failure("stale_provenance", "材料版本不可用，请重新打开材料。", 409)
        selected = await candidates(session, identity, after=after, limit=limit + 1)
        scanned = selected[:limit]
        next_cursor = scanned[-1].segment_id if len(selected) > limit else None
        await session.rollback()
        validated = await asyncio.to_thread(validate_page, identity, chapter_id, scanned)

        # A new read snapshot gates ancestors and immutable identity after CPU work.
        current = MaterialIdentity.capture(await require_material(session, material_id))
        if current != identity:
            raise failure("stale_provenance", "材料正文身份已变化，请重新打开材料。", 409)
        visible = {
            row.segment_id: row
            for row in await candidates(session, identity, ids=[row.segment_id for row in scanned])
        }
        items: list[MaterialChapterSegment] = []
        unavailable = 0
        for original in scanned:
            latest = visible.get(original.segment_id)
            if latest is None:
                continue
            if latest != original:
                unavailable += 1
                continue
            item, invalid = validated[original.segment_id]
            unavailable += int(invalid)
            if item is not None:
                items.append(item)
        return MaterialChapterSegmentsResponse(
            items=items, next_cursor=next_cursor, unavailable_count=unavailable
        )
    finally:
        await session.rollback()
