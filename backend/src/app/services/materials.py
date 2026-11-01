"""Transactional managed EPUB publication and validated reading state."""

import asyncio
import hashlib
from datetime import datetime
from typing import TYPE_CHECKING

from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from app.epub_schemas import CompiledBook
from app.epub_storage import decode as decode_epub
from app.epub_storage import encode as encode_epub
from app.ids import new_ulid
from app.material_models import (
    ChapterReadingPosition,
    Material,
    ReadingPosition,
)
from app.material_schemas import (
    ChapterResource,
    ChapterSummary,
    MaterialChapterResponse,
    MaterialImportResponse,
    MaterialResponse,
    MaterialSummary,
    PositionAnchor,
    ReadingPositionResponse,
    ReadingPositionUpdate,
)
from app.models import Source
from app.readings_schemas import MaterialReadingsPrepare
from app.services import readings
from app.services.epub import EpubError, compile_epub_bytes
from app.services.epub_readings import text_resources
from app.services.material_cleanup import clear_material_assets
from app.services.position_progress import chapter_progress
from app.services.reader_views import MaterialIdentity
from app.services.sources import as_utc, begin_write, require_source, utc_now

if TYPE_CHECKING:
    from app.services.reader_views import ReaderViews

MAX_UPLOAD_BYTES = 32 * 1024 * 1024


def bundle(material: Material) -> CompiledBook:
    return decode_epub(material.compiled_bundle)


async def require_material(
    session: AsyncSession, material_id: str, *, with_bundle: bool = True
) -> Material:
    statement = (
        select(Material)
        .join(Source, Material.source_id == Source.id)
        .where(
            Material.id == material_id, Material.deleted_at.is_(None), Source.deleted_at.is_(None)
        )
    )
    if not with_bundle:
        statement = statement.options(defer(Material.compiled_bundle))
    material = await session.scalar(statement)
    if material is None:
        raise HTTPException(404, "材料不存在")
    return material


def summary(material: Material) -> MaterialSummary:
    return MaterialSummary(
        id=material.id,
        source_id=material.source_id,
        title=material.title,
        source_sha256=material.source_sha256,
        version_id=material.version_id,
        product_sha256=material.product_sha256,
        contract_version=material.contract_version,
        created_at=as_utc(material.created_at),
        warnings=material.warnings,
    )


async def response(session: AsyncSession, material: Material) -> MaterialResponse:
    book = await asyncio.to_thread(bundle, material)
    position = await session.get(ReadingPosition, material.id)
    chapter_rows = {
        row.chapter_id: row
        for row in (
            await session.scalars(
                select(ChapterReadingPosition).where(
                    ChapterReadingPosition.material_id == material.id
                )
            )
        ).all()
    }

    def position_response(row: ReadingPosition | ChapterReadingPosition) -> ReadingPositionResponse:
        anchor = PositionAnchor.model_validate_json(row.payload)
        return ReadingPositionResponse(
            **anchor.model_dump(),
            revision=row.revision,
            updated_at=as_utc(row.updated_at),
            progress=chapter_progress(book, anchor),
        )

    return MaterialResponse(
        **summary(material).model_dump(),
        chapters=[
            ChapterSummary(id=c.id, title=c.title, level=c.level, part_count=len(c.parts))
            for c in book.chapters
        ],
        reading_position=position_response(position) if position else None,
        chapter_positions=[
            position_response(chapter_rows[c.id]) for c in book.chapters if c.id in chapter_rows
        ],
    )


async def list_materials(session: AsyncSession, source_id: str) -> list[MaterialSummary]:
    await require_source(session, source_id)
    materials = (
        await session.scalars(
            select(Material)
            .options(defer(Material.compiled_bundle))
            .where(Material.source_id == source_id, Material.deleted_at.is_(None))
            .order_by(Material.created_at, Material.id)
        )
    ).all()
    return [summary(m) for m in materials]


async def reject_deleted_import(
    session: AsyncSession, source_id: str, digest: str, started_at: datetime
) -> None:
    """A request predating removal cannot recreate or publish into its replacement."""
    removed = await session.scalar(
        select(Material.id)
        .where(
            Material.source_id == source_id,
            Material.source_sha256 == digest,
            Material.deleted_at >= started_at,
        )
        .limit(1)
    )
    if removed is not None:
        raise HTTPException(404, "材料已删除，请重新导入")


async def import_material(
    session: AsyncSession, source_id: str, request: Request
) -> MaterialImportResponse:
    if request.headers.get("content-type", "").split(";")[0].strip() != "application/epub+zip":
        raise HTTPException(415, "请上传 EPUB 文件")
    started_at = utc_now()
    await require_source(session, source_id)
    await session.rollback()  # Release the read snapshot before bounded compilation.
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "EPUB 文件超过 32 MiB")
        data.extend(chunk)
    raw = bytes(data)
    del data
    digest = hashlib.sha256(raw).hexdigest()
    await reject_deleted_import(session, source_id, digest, started_at)
    existing = await session.scalar(
        select(Material)
        .join(Source, Material.source_id == Source.id)
        .where(
            Material.source_id == source_id,
            Material.source_sha256 == digest,
            Material.deleted_at.is_(None),
            Source.deleted_at.is_(None),
        )
    )
    if existing is not None:
        existing_id, existing_version = existing.id, existing.version_id
        await session.rollback()
        await readings.prepare(
            session, existing_id, MaterialReadingsPrepare(version_id=existing_version)
        )
        await session.rollback()
        try:
            await begin_write(session)
            await require_source(session, source_id)
            await reject_deleted_import(session, source_id, digest, started_at)
            existing = await require_material(session, existing_id)
            await session.commit()
            return MaterialImportResponse(material=await response(session, existing), reused=True)
        except BaseException:
            await session.rollback()
            raise
    await session.rollback()
    try:
        book = await asyncio.to_thread(compile_epub_bytes, raw)
    except EpubError as exc:
        raise HTTPException(422, str(exc)) from exc
    generated = await readings.build(text_resources(book))
    compiled = await asyncio.to_thread(encode_epub, book)
    try:
        await begin_write(session)
        await require_source(session, source_id)
        await reject_deleted_import(session, source_id, digest, started_at)
        material = await session.scalar(
            select(Material).where(
                Material.source_id == source_id,
                Material.source_sha256 == digest,
                Material.deleted_at.is_(None),
            )
        )
        reused = material is not None
        if material is None:
            material = Material(
                id=new_ulid(),
                source_id=source_id,
                title=book.title,
                source_sha256=digest,
                version_id=new_ulid(),
                product_sha256=book.product_sha256,
                contract_version=book.contract,
                original_bytes=raw,
                warnings=book.warnings,
                compiled_bundle=compiled,
                created_at=utc_now(),
            )
            session.add(material)
            await session.flush()
        await readings.publish(session, material, generated, None)
        await session.commit()
        return MaterialImportResponse(material=await response(session, material), reused=reused)
    except BaseException:
        await session.rollback()
        raise


async def get_material(session: AsyncSession, material_id: str) -> MaterialResponse:
    return await response(session, await require_material(session, material_id))


async def get_chapter(
    session: AsyncSession, material_id: str, chapter_id: str
) -> MaterialChapterResponse:
    material = await require_material(session, material_id)
    book = await asyncio.to_thread(bundle, material)
    chapter = next((c for c in book.chapters if c.id == chapter_id), None)
    if chapter is None:
        raise HTTPException(404, "章节不存在")
    ids = {p.resource_id for p in chapter.parts}
    return MaterialChapterResponse(
        material_id=material.id,
        version_id=material.version_id,
        **chapter.model_dump(),
        resources=[ChapterResource(**r.model_dump()) for r in book.resources if r.id in ids],
    )


async def save_position(
    session: AsyncSession,
    material_id: str,
    data: ReadingPositionUpdate,
    *,
    reader_views: "ReaderViews",
) -> ReadingPositionResponse:
    try:
        anchor = PositionAnchor.model_validate(data.model_dump(exclude={"expected_revision"}))
        prepared = await reader_views.validate_position(material_id, data)
        await session.rollback()
        await begin_write(session)
        material = await require_material(session, material_id, with_bundle=False)
        if material.version_id != data.version_id:
            raise HTTPException(422, "位置版本无效")
        if prepared.identity != MaterialIdentity.from_material(material):
            raise HTTPException(409, "材料版本已改变")
        position = await session.get(ReadingPosition, material_id)
        revision = position.revision if position else 0
        if data.expected_revision != revision:
            raise HTTPException(409, "阅读位置已更新，请重新读取")
        now = utc_now()
        if position is None:
            position = ReadingPosition(
                material_id=material_id,
                revision=revision + 1,
                payload=anchor.model_dump_json(),
                updated_at=now,
            )
            session.add(position)
        else:
            position.revision += 1
            position.payload = anchor.model_dump_json()
            position.updated_at = now
        chapter_position = await session.get(ChapterReadingPosition, (material_id, data.chapter_id))
        if chapter_position is None:
            chapter_position = ChapterReadingPosition(
                material_id=material_id, chapter_id=data.chapter_id
            )
            session.add(chapter_position)
        chapter_position.revision = position.revision
        chapter_position.payload = anchor.model_dump_json()
        chapter_position.updated_at = now
        result = ReadingPositionResponse(
            **anchor.model_dump(),
            revision=position.revision,
            updated_at=now,
            progress=prepared.progress,
        )
        await session.commit()
        return result
    except BaseException:
        await session.rollback()
        raise


async def delete_material(session: AsyncSession, material_id: str) -> None:
    """Keep a tombstone and remove this material's assets atomically."""
    try:
        await begin_write(session)
        existing_id = await session.scalar(
            select(Material.id)
            .join(Source, Material.source_id == Source.id)
            .where(Material.id == material_id, Source.deleted_at.is_(None))
        )
        if existing_id is None:
            raise HTTPException(404, "材料不存在")
        from app.services.translations import revoke_tasks

        await revoke_tasks(session, material_id=material_id)
        await clear_material_assets(
            session, select(Material.id).where(Material.id == material_id), utc_now()
        )
        await session.commit()
    except BaseException:
        await session.rollback()
        raise
