"""Strict material reference validation and atomic Segment creation receipts."""

import asyncio
import hashlib
import json
import unicodedata
import zlib
from dataclasses import dataclass
from typing import cast

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.epub_schemas import CompiledBook, CompiledResource
from app.ids import new_ulid
from app.material_models import Material
from app.models import Segment, SegmentMaterialProvenance, Source
from app.provenance_schemas import (
    ASSEMBLY_RULE,
    MAX_PROVENANCE_CONTEXT,
    MAX_PROVENANCE_MATCHES,
    MAX_PROVENANCE_TEXT,
    MaterialProvenance,
    MaterialProvenanceRange,
    ProvenancePart,
    SegmentProvenanceResponse,
)
from app.schemas import SegmentCreate, SegmentProvenanceMatches, SegmentResponse
from app.services.sources import (
    begin_write,
    lock_segment_text,
    require_segment,
    require_source,
    segment_response,
    utc_now,
)


class ProvenanceError(ValueError):
    def __init__(self, message: str, *, snapshot: bool = False) -> None:
        super().__init__(message)
        self.snapshot = snapshot


def failure(code: str, message: str, status: int = 422) -> HTTPException:
    return HTTPException(status, {"code": code, "message": message})


def identity_payload(reference: MaterialProvenance) -> str:
    return json.dumps(
        [
            reference.material_id,
            reference.version_id,
            [
                [item.resource_id, item.spine_index, item.start, item.end]
                for item in reference.ranges
            ],
        ],
        ensure_ascii=True,
        separators=(",", ":"),
    )


def identity_sha256(reference: MaterialProvenance) -> str:
    return hashlib.sha256(identity_payload(reference).encode()).hexdigest()


def _resource(book: CompiledBook, item: MaterialProvenanceRange) -> CompiledResource:
    if item.spine_index >= len(book.resources):
        raise ProvenanceError("材料出现位置不存在")
    resource = book.resources[item.spine_index]
    if resource.id != item.resource_id:
        raise ProvenanceError("资源与 spine 出现位置不一致")
    if any(
        other.text != resource.text or other.text_sha256 != resource.text_sha256
        for other in book.resources
        if other.id == resource.id
    ):
        raise ProvenanceError("同一资源正文身份不一致", snapshot=True)
    try:
        digest = hashlib.sha256(resource.text.encode()).hexdigest()
    except UnicodeError as exc:
        raise ProvenanceError("资源正文不是有效 Unicode", snapshot=True) from exc
    if (
        unicodedata.normalize("NFC", resource.text) != resource.text
        or digest != resource.text_sha256
        or digest != item.text_sha256
    ):
        raise ProvenanceError("资源正文摘要不匹配", snapshot=True)
    if item.end > len(resource.text):
        raise ProvenanceError("范围超过资源正文上界")
    if item.exact != resource.text[item.start : item.end]:
        raise ProvenanceError("原文快照不匹配", snapshot=True)
    return resource


def project_ranges(
    book: CompiledBook,
    reference: MaterialProvenance,
) -> tuple[str, list[ProvenancePart]]:
    """Project all ranges into one continuous chapter interval without sorting input."""
    chosen_chapter: str | None = None
    previous_end: int | None = None
    projections: list[ProvenancePart] = []
    for range_index, item in enumerate(reference.ranges):
        matches: list[tuple[str, int, int, list[ProvenancePart]]] = []
        for chapter in book.chapters:
            offset = 0
            cursor = item.start
            start_position: int | None = None
            end_position = 0
            pieces: list[ProvenancePart] = []
            for part_index, part in enumerate(chapter.parts):
                if part.start < 0 or part.end < part.start:
                    raise ProvenanceError("章节范围无效")
                if part.resource_id == item.resource_id and part.spine_index == item.spine_index:
                    left, right = max(item.start, part.start), min(item.end, part.end)
                    if left < right:
                        position = offset + left - part.start
                        if left != cursor or (pieces and position != end_position):
                            break
                        if start_position is None:
                            start_position = offset + left - part.start
                        pieces.append(
                            ProvenancePart(
                                range_index=range_index,
                                part_index=part_index,
                                resource_id=item.resource_id,
                                spine_index=item.spine_index,
                                start=left,
                                end=right,
                            )
                        )
                        cursor = right
                        end_position = offset + right - part.start
                offset += part.end - part.start
            if cursor == item.end and start_position is not None:
                matches.append((chapter.id, start_position, end_position, pieces))
        if len(matches) != 1:
            raise ProvenanceError("目标必须完整位于同一逻辑章，且出现位置须明确")
        chapter_id, start, end, pieces = matches[0]
        if chosen_chapter is None:
            chosen_chapter = chapter_id
        if chosen_chapter != chapter_id or (previous_end is not None and previous_end != start):
            raise ProvenanceError("目标范围须按阅读顺序连续，不能重叠、跳跃或跨章")
        previous_end = end
        projections.extend(pieces)
    if chosen_chapter is None:
        raise ProvenanceError("目标范围为空")
    return chosen_chapter, projections


def validate_reference(
    book: CompiledBook,
    reference: MaterialProvenance,
) -> tuple[MaterialProvenance, str, str, list[ProvenancePart]]:
    """Validate exact snapshots, then canonicalize adjacent same-occurrence slices."""
    resources = [_resource(book, item) for item in reference.ranges]
    project_ranges(book, reference)
    canonical: list[MaterialProvenanceRange] = []
    for item, resource in zip(reference.ranges, resources, strict=True):
        if canonical and (
            canonical[-1].resource_id == item.resource_id
            and canonical[-1].spine_index == item.spine_index
            and canonical[-1].end == item.start
        ):
            previous = canonical.pop()
            item = item.model_copy(
                update={"start": previous.start, "exact": previous.exact + item.exact}
            )
        canonical.append(
            item.model_copy(
                update={
                    "prefix": resource.text[
                        max(0, item.start - MAX_PROVENANCE_CONTEXT) : item.start
                    ],
                    "suffix": resource.text[item.end : item.end + MAX_PROVENANCE_CONTEXT],
                }
            )
        )
    normalized = reference.model_copy(update={"ranges": canonical})
    assembled = unicodedata.normalize("NFC", "".join(item.exact for item in canonical))
    if not assembled.strip() or len(assembled) > MAX_PROVENANCE_TEXT:
        raise ProvenanceError("目标原文须非空白且不超过限额")
    chapter, parts = project_ranges(book, normalized)
    return normalized, assembled, chapter, parts


@dataclass(frozen=True)
class PreparedReference:
    reference: MaterialProvenance
    text: str
    chapter_id: str
    parts: list[ProvenancePart]
    source_id: str
    product_sha256: str
    contract_version: str
    compiled_bundle: bytes


def _validate_bundle(
    material: Material,
    reference: MaterialProvenance,
) -> tuple[MaterialProvenance, str, str, list[ProvenancePart]]:
    try:
        book = CompiledBook.model_validate_json(zlib.decompress(material.compiled_bundle))
    except (ValueError, zlib.error) as exc:
        raise ProvenanceError("材料版本产物不可用", snapshot=True) from exc
    if book.product_sha256 != material.product_sha256 or book.contract != material.contract_version:
        raise ProvenanceError("材料版本产物身份不匹配", snapshot=True)
    return validate_reference(book, reference)


async def prepare_reference(
    session: AsyncSession,
    source_id: str,
    reference: MaterialProvenance,
) -> PreparedReference:
    """Read immutable bytes, release the snapshot, then perform bounded validation."""
    await require_source(session, source_id)
    material = await session.scalar(
        select(Material).where(
            Material.id == reference.material_id,
            Material.source_id == source_id,
            Material.deleted_at.is_(None),
        )
    )
    if material is None:
        raise failure("not_found", "材料不存在或不属于当前来源", 404)
    if material.version_id != reference.version_id:
        raise failure("stale_provenance", "材料版本不可用", 409)
    # expire_on_commit=False is the application's session contract; capture values before rollback.
    source, product, contract, compiled = (
        material.source_id,
        material.product_sha256,
        material.contract_version,
        material.compiled_bundle,
    )
    # Validation runs in a thread on an independent value, never a live ORM object.
    material_copy = Material(
        compiled_bundle=compiled, product_sha256=product, contract_version=contract
    )
    await session.rollback()
    try:
        normalized, target, chapter, parts = await asyncio.to_thread(
            _validate_bundle,
            material_copy,
            reference,
        )
    except ProvenanceError as exc:
        raise failure("invalid_provenance", str(exc)) from exc
    return PreparedReference(
        normalized, target, chapter, parts, source, product, contract, compiled
    )


async def recheck_reference(session: AsyncSession, prepared: PreparedReference) -> Material:
    """Recheck visibility and every immutable input under the caller's transaction."""
    await require_source(session, prepared.source_id)
    material = await session.scalar(
        select(Material)
        .where(
            Material.id == prepared.reference.material_id,
            Material.source_id == prepared.source_id,
            Material.deleted_at.is_(None),
        )
        .execution_options(populate_existing=True)
    )
    if material is None:
        raise failure("not_found", "材料已删除", 404)
    if (
        material.version_id != prepared.reference.version_id
        or material.product_sha256 != prepared.product_sha256
        or material.contract_version != prepared.contract_version
        or material.compiled_bundle != prepared.compiled_bundle
    ):
        raise failure("stale_provenance", "材料正文身份已变化", 409)
    return material


def request_payload(data: SegmentCreate) -> str:
    return json.dumps(
        data.model_dump(mode="json", exclude_unset=True),
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    )


async def replay_creation(
    session: AsyncSession,
    source_id: str,
    data: SegmentCreate,
) -> SegmentResponse | None:
    await require_source(session, source_id)
    receipt = await session.scalar(
        select(SegmentMaterialProvenance).where(
            SegmentMaterialProvenance.source_id == source_id,
            SegmentMaterialProvenance.request_id == str(data.request_id),
        )
    )
    if receipt is None:
        return None
    segment = await require_segment(session, receipt.segment_id)
    if receipt.request_payload != request_payload(data):
        raise failure("idempotency_conflict", "同一请求身份不能提交不同内容", 409)
    return segment_response(segment)


async def create_material_segment(
    session: AsyncSession,
    source_id: str,
    data: SegmentCreate,
) -> SegmentResponse:
    reference = data.material_provenance
    if reference is None or data.request_id is None:
        raise failure("invalid_provenance", "材料出处和请求身份不能为空")
    try:
        replay = await replay_creation(session, source_id, data)
        if replay is not None:
            await session.rollback()
            return replay
        await session.rollback()
        prepared = await prepare_reference(session, source_id, reference)
        if data.text is not None and data.text != prepared.text:
            raise failure("invalid_provenance", "提交原文与材料出处不一致")
        await begin_write(session)
        # Another request may have committed while validation ran outside the write lock.
        replay = await replay_creation(session, source_id, data)
        if replay is not None:
            await session.commit()
            return replay
        await recheck_reference(session, prepared)
        created = utc_now()
        segment = Segment(
            id=new_ulid(),
            source_id=source_id,
            text=prepared.text,
            created_at=created,
            updated_at=created,
            revision=1,
            **data.model_dump(exclude={"text", "request_id", "material_provenance"}),
        )
        lock_segment_text(segment, created)
        segment.material_provenance = SegmentMaterialProvenance(
            source_id=source_id,
            material_id=reference.material_id,
            version_id=reference.version_id,
            payload=prepared.reference.model_dump_json(),
            identity_sha256=identity_sha256(prepared.reference),
            request_id=str(data.request_id),
            request_payload=request_payload(data),
            assembly_rule=ASSEMBLY_RULE,
            created_at=created,
        )
        session.add(segment)
        await session.flush()
        result = segment_response(segment)
        await session.commit()
        return result
    except BaseException:
        await session.rollback()
        raise


def _matches_saved_reference(segment: Segment, prepared: PreparedReference) -> bool:
    origin = segment.material_provenance
    if origin is None or (
        origin.assembly_rule != ASSEMBLY_RULE
        or origin.source_id != segment.source_id
        or origin.material_id != prepared.reference.material_id
        or origin.version_id != prepared.reference.version_id
        or segment.text != prepared.text
    ):
        return False
    try:
        stored = MaterialProvenance.model_validate_json(origin.payload)
    except ValidationError:
        return False
    if identity_payload(stored) != identity_payload(prepared.reference):
        return False
    # Exact/hash validate historical snapshots; recognition context never defines identity.
    return all(
        old.exact == current.exact and old.text_sha256 == current.text_sha256
        for old, current in zip(stored.ranges, prepared.reference.ranges, strict=True)
    )


async def matches(
    session: AsyncSession,
    source_id: str,
    reference: MaterialProvenance,
) -> SegmentProvenanceMatches:
    try:
        prepared = await prepare_reference(session, source_id, reference)
        await recheck_reference(session, prepared)
        rows = (
            await session.scalars(
                select(Segment)
                .join(SegmentMaterialProvenance, Segment.id == SegmentMaterialProvenance.segment_id)
                .join(Source, Segment.source_id == Source.id)
                .where(
                    Segment.source_id == source_id,
                    Segment.deleted_at.is_(None),
                    Source.deleted_at.is_(None),
                    SegmentMaterialProvenance.identity_sha256
                    == identity_sha256(prepared.reference),
                )
                .order_by(Segment.created_at.desc(), Segment.id.desc())
                .limit(MAX_PROVENANCE_MATCHES + 1)
            )
        ).all()
        visible_matches = [row for row in rows if _matches_saved_reference(row, prepared)]
        result = SegmentProvenanceMatches(
            segments=[segment_response(row) for row in visible_matches[:MAX_PROVENANCE_MATCHES]],
            truncated=len(rows) > MAX_PROVENANCE_MATCHES,
        )
        await session.rollback()
        return result
    except BaseException:
        await session.rollback()
        raise


async def select_existing(
    session: AsyncSession,
    segment_id: str,
    reference: MaterialProvenance,
) -> SegmentResponse:
    try:
        segment = await require_segment(session, segment_id)
        source_id = segment.source_id
        await session.rollback()
        prepared = await prepare_reference(session, source_id, reference)
        await recheck_reference(session, prepared)
        segment = await require_segment(session, segment_id)
        if not _matches_saved_reference(segment, prepared):
            raise failure("stale_provenance", "片段出处已失效或与所选目标不一致", 409)
        result = segment_response(segment)
        await session.rollback()
        return result
    except BaseException:
        await session.rollback()
        raise


def chapter_location(
    book: CompiledBook, chapter_id: str, parts: list[ProvenancePart]
) -> str | None:
    """Derive chapter display from immutable part order, never reader layout or position."""
    chapter = next((item for item in book.chapters if item.id == chapter_id), None)
    if chapter is None:
        return None
    label = chapter.title if chapter.title.strip() else ""
    if not parts:
        return label
    target = parts[0]
    pieces: list[str] = []
    start: int | None = None
    offset = 0
    for index, part in enumerate(chapter.parts):
        if not 0 <= part.spine_index < len(book.resources):
            return label
        resource = book.resources[part.spine_index]
        if (
            resource.id != part.resource_id
            or not 0 <= part.start <= part.end <= len(resource.text)
            or unicodedata.normalize("NFC", resource.text) != resource.text
        ):
            return label
        try:
            digest = hashlib.sha256(resource.text.encode()).hexdigest()
        except UnicodeError:
            return label
        if digest != resource.text_sha256:
            return label
        if index == target.part_index:
            if (
                target.resource_id != part.resource_id
                or target.spine_index != part.spine_index
                or not part.start <= target.start < target.end <= part.end
            ):
                return label
            start = offset + target.start - part.start
        pieces.append(resource.text[part.start : part.end])
        offset += part.end - part.start
    raw = "".join(pieces)
    whole = unicodedata.normalize("NFC", raw)
    if start is None or not whole:
        return label
    prefix = unicodedata.normalize("NFC", raw[:start])
    rest = unicodedata.normalize("NFC", raw[start:])
    if prefix + rest != whole or not 0 <= len(prefix) < len(whole):
        return label
    percentage = f"章内约 {100 * len(prefix) // len(whole)}%"
    return " · ".join(item for item in (label, percentage) if item)


def _prepared_location(prepared: PreparedReference) -> tuple[str | None, str | None]:
    book = CompiledBook.model_validate_json(zlib.decompress(prepared.compiled_bundle))
    chapter = next((item for item in book.chapters if item.id == prepared.chapter_id), None)
    chapter_title = chapter.title if chapter is not None and chapter.title.strip() else None
    return chapter_title, chapter_location(book, prepared.chapter_id, prepared.parts)


def _display_title(
    segment: Segment, reference: MaterialProvenance, material: Material | None
) -> str | None:
    origin = segment.material_provenance
    if (
        material is None
        or origin is None
        or material.source_id != segment.source_id
        or origin.source_id != segment.source_id
        or origin.material_id != reference.material_id
        or material.id != reference.material_id
    ):
        return None
    return material.title if material.title.strip() else None


async def resolve(session: AsyncSession, segment_id: str) -> SegmentProvenanceResponse:
    segment = await require_segment(session, segment_id)
    origin = segment.material_provenance
    if origin is None:
        return SegmentProvenanceResponse(
            segment_id=segment_id, material_provenance=None, status="none"
        )
    try:
        reference = MaterialProvenance.model_validate_json(origin.payload)
    except ValidationError:
        return SegmentProvenanceResponse(
            segment_id=segment_id, material_provenance=None, status="invalid_reference"
        )
    result = SegmentProvenanceResponse(
        segment_id=segment_id, material_provenance=reference, status="version_unavailable"
    )
    material = await session.get(Material, origin.material_id)
    if material is None:
        return result
    title = _display_title(segment, reference, material)
    result = result.model_copy(update={"display": title, "title": title})
    if material.deleted_at is not None:
        return result.model_copy(update={"status": "material_deleted"})
    if material.version_id != reference.version_id:
        return result
    if (
        material.source_id != segment.source_id
        or origin.source_id != segment.source_id
        or origin.material_id != reference.material_id
        or origin.version_id != reference.version_id
        or origin.assembly_rule != ASSEMBLY_RULE
    ):
        return result.model_copy(update={"status": "invalid_reference"})
    original_text = segment.text
    source_id = segment.source_id
    try:
        prepared = await prepare_reference(session, source_id, reference)
        chapter_title, location = await asyncio.to_thread(_prepared_location, prepared)
        # Re-read after off-thread work so ancestor/material deletion cannot expose stale success.
        await require_segment(session, segment_id)
        material = await recheck_reference(session, prepared)
    except HTTPException as exc:
        # Ancestor deletion is still a visibility gate, never a historical location status.
        await require_segment(session, segment_id)
        current_material = await session.get(
            Material, reference.material_id, populate_existing=True
        )
        title = _display_title(segment, reference, current_material)
        result = result.model_copy(update={"display": title, "title": title})
        if current_material is not None and current_material.deleted_at is not None:
            return result.model_copy(update={"status": "material_deleted"})
        detail = exc.detail
        if (
            isinstance(detail, dict)
            and cast(dict[str, object], detail).get("code") == "stale_provenance"
        ):
            return result
        return result.model_copy(update={"status": "snapshot_mismatch"})
    title = _display_title(segment, reference, material)
    result = result.model_copy(update={"display": title, "title": title})
    if prepared.text != original_text:
        return result.model_copy(update={"status": "snapshot_mismatch"})
    return result.model_copy(
        update={
            "status": "resolved",
            "chapter_id": prepared.chapter_id,
            "chapter_title": chapter_title,
            "parts": prepared.parts,
            "display": " · ".join(item for item in (result.display, location) if item) or None,
        }
    )
