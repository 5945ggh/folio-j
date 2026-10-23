"""Read exact successful translations in chapter order without creating learning content."""

import asyncio
import base64
import binascii
import zlib
from dataclasses import dataclass
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.epub_schemas import CompiledBook
from app.provenance_schemas import MaterialProvenance, ProvenancePart
from app.services.material_provenance import (
    ProvenanceError,
    failure,
    identity_sha256,
    validate_reference,
)
from app.services.material_segments import MaterialIdentity
from app.services.materials import require_material
from app.services.sources import as_utc
from app.translation_models import TranslationResult, TranslationTask
from app.translation_schemas import MaterialChapterTranslation, MaterialChapterTranslations

Position = tuple[int, int, int, int, str]


class Cursor(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    material_id: str
    version_id: str
    chapter_id: str
    position: tuple[int, int, int, int, str]


class Payload(BaseModel):
    material_provenance: MaterialProvenance
    chapter_id: str
    parts: list[ProvenancePart] = Field(min_length=1)
    text: str
    target_language: str = Field(min_length=1)


class AttributionReference(BaseModel):
    material_id: str
    version_id: str


class Attribution(BaseModel):
    chapter_id: str
    material_provenance: AttributionReference


@dataclass(frozen=True)
class Candidate:
    result_id: str
    source_id: str
    identity_sha256: str
    payload: str
    translation: str
    created_at: datetime


@dataclass(frozen=True)
class Validated:
    item: MaterialChapterTranslation
    position: Position


async def candidates(session: AsyncSession, material_id: str) -> list[Candidate]:
    rows = (
        await session.execute(
            select(
                TranslationResult.id,
                TranslationTask.source_id,
                TranslationTask.identity_sha256,
                TranslationTask.payload,
                TranslationResult.translation,
                TranslationResult.created_at,
            )
            .join(TranslationTask, TranslationTask.id == TranslationResult.task_id)
            .where(
                TranslationTask.material_id == material_id,
                TranslationTask.status == "succeeded",
                TranslationTask.result_id == TranslationResult.id,
            )
        )
    ).all()
    return [Candidate(*row) for row in rows]


def decode_cursor(
    after: str | None, identity: MaterialIdentity, chapter_id: str
) -> Position | None:
    if after is None:
        return None
    try:
        cursor = Cursor.model_validate_json(base64.b64decode(after, altchars=b"-_", validate=True))
        if (
            (cursor.material_id, cursor.version_id, cursor.chapter_id)
            != (identity.id, identity.version_id, chapter_id)
            or any(value < 0 for value in cursor.position[:4])
            or cursor.position[2] < cursor.position[0]
            or (
                cursor.position[0] == cursor.position[2]
                and cursor.position[1] >= cursor.position[3]
            )
            or len(cursor.position[4]) != 64
            or any(char not in "0123456789abcdef" for char in cursor.position[4])
        ):
            raise ValueError("cursor scope or position mismatch")
    except (ValidationError, ValueError, binascii.Error) as exc:
        raise failure("invalid_cursor", "翻译记录游标无效，请重新读取本章。") from exc
    return cursor.position


def validate_candidates(
    identity: MaterialIdentity, chapter_id: str, rows: list[Candidate]
) -> dict[str, tuple[Validated | None, bool]]:
    try:
        book = CompiledBook.model_validate_json(zlib.decompress(identity.compiled_bundle))
    except (ValueError, zlib.error) as exc:
        raise failure("material_unavailable", "材料版本产物不可用，请重新打开材料。", 409) from exc
    if book.product_sha256 != identity.product_sha256 or book.contract != identity.contract_version:
        raise failure("material_unavailable", "材料版本产物身份不匹配。", 409)
    if not any(chapter.id == chapter_id for chapter in book.chapters):
        raise failure("not_found", "章节不存在。", 404)
    validated: dict[str, tuple[Validated | None, bool]] = {}
    for row in rows:
        belongs = False
        try:
            attribution = Attribution.model_validate_json(row.payload)
            belongs = (
                row.source_id == identity.source_id
                and attribution.chapter_id == chapter_id
                and attribution.material_provenance.material_id == identity.id
                and attribution.material_provenance.version_id == identity.version_id
            )
            payload = Payload.model_validate_json(row.payload)
            reference = payload.material_provenance
            if (
                row.source_id != identity.source_id
                or reference.material_id != identity.id
                or reference.version_id != identity.version_id
            ):
                raise ProvenanceError("译文出处身份不匹配")
            normalized, text, chapter, parts = validate_reference(book, reference)
            digest = identity_sha256(normalized)
            if (
                row.identity_sha256 != digest
                or payload.text != text
                or payload.chapter_id != chapter
                or payload.parts != parts
                or not row.translation.strip()
            ):
                raise ProvenanceError("译文输入与确切出处不匹配")
        except (ValidationError, ProvenanceError):
            validated[row.result_id] = (None, belongs)
            continue
        item = None
        if chapter == chapter_id:
            first, last = parts[0], parts[-1]
            item = Validated(
                MaterialChapterTranslation(
                    identity_sha256=digest,
                    result_id=row.result_id,
                    material_provenance=normalized,
                    excerpt=text[:160],
                    translation_excerpt=row.translation[:160],
                    result_count=1,
                    target_language=payload.target_language,
                    created_at=as_utc(row.created_at),
                ),
                (first.part_index, first.start, last.part_index, last.end, digest),
            )
        validated[row.result_id] = (item, False)
    return validated


async def list_chapter_translations(
    session: AsyncSession,
    material_id: str,
    chapter_id: str,
    version_id: str,
    after: str | None,
    limit: int,
) -> MaterialChapterTranslations:
    try:
        identity = MaterialIdentity.capture(await require_material(session, material_id))
        if identity.version_id != version_id:
            raise failure("stale_provenance", "材料版本不可用，请重新打开材料。", 409)
        position = decode_cursor(after, identity, chapter_id)
        rows = await candidates(session, material_id)
        await session.rollback()
        validated = await asyncio.to_thread(validate_candidates, identity, chapter_id, rows)

        # Recheck after CPU work using a fresh read snapshot, as chapter Segment scans do.
        current = MaterialIdentity.capture(await require_material(session, material_id))
        if current != identity:
            raise failure("stale_provenance", "材料正文身份已变化，请重新打开材料。", 409)
        visible = {row.result_id: row for row in await candidates(session, material_id)}
        groups: dict[str, Validated] = {}
        counts: dict[str, int] = {}
        unavailable: set[str] = set()
        for row in rows:
            latest = visible.get(row.result_id)
            if latest is None:
                continue
            item, invalid = validated[row.result_id]
            if latest != row:
                if item is not None or invalid:
                    unavailable.add(row.identity_sha256)
                continue
            if invalid:
                unavailable.add(row.identity_sha256)
            if item is None:
                continue
            digest = item.item.identity_sha256
            counts[digest] = counts.get(digest, 0) + 1
            previous = groups.get(digest)
            if previous is None or (item.item.created_at, item.item.result_id) > (
                previous.item.created_at,
                previous.item.result_id,
            ):
                groups[digest] = item
        ordered = sorted(
            (item for item in groups.values() if position is None or item.position > position),
            key=lambda item: item.position,
        )
        page = ordered[:limit]
        next_cursor = None
        if len(ordered) > limit:
            next_cursor = base64.urlsafe_b64encode(
                Cursor(
                    material_id=material_id,
                    version_id=version_id,
                    chapter_id=chapter_id,
                    position=page[-1].position,
                )
                .model_dump_json()
                .encode()
            ).decode()
        return MaterialChapterTranslations(
            items=[
                item.item.model_copy(update={"result_count": counts[item.item.identity_sha256]})
                for item in page
            ],
            next_cursor=next_cursor,
            unavailable_count=len(unavailable - groups.keys()),
        )
    finally:
        await session.rollback()
