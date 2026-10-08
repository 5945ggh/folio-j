"""Atomic publication of complete local readings; generation runs outside transactions."""

import asyncio
import json
import zlib

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.epub_schemas import CompiledBook
from app.ids import new_ulid
from app.material_models import Material, MaterialReadingsCurrent, MaterialReadingsGeneration
from app.nlp.tokenization import GeneratedReadings, generate
from app.readings_schemas import (
    MaterialReadingsPrepare,
    MaterialReadingsResponse,
    MaterialReadingsSummary,
    MaterialResourceReadings,
)
from app.services.sources import begin_write, utc_now


def summary(asset: MaterialReadingsGeneration) -> MaterialReadingsSummary:
    return MaterialReadingsSummary(
        material_id=asset.material_id,
        version_id=asset.version_id,
        generation_id=asset.id,
        token_count=asset.token_count,
    )


async def current(session: AsyncSession, material: Material) -> MaterialReadingsGeneration | None:
    asset = await session.scalar(
        select(MaterialReadingsGeneration)
        .join(
            MaterialReadingsCurrent,
            MaterialReadingsCurrent.generation_id == MaterialReadingsGeneration.id,
        )
        .where(
            MaterialReadingsCurrent.material_id == material.id,
            MaterialReadingsGeneration.version_id == material.version_id,
        )
    )
    return asset


async def build(book: CompiledBook) -> GeneratedReadings:
    try:
        return await asyncio.to_thread(generate, book)
    except Exception as exc:
        raise HTTPException(503, "本地注音生成失败，请重试。") from exc


async def publish(
    session: AsyncSession,
    material: Material,
    generated: GeneratedReadings,
    observed_id: str | None,
) -> MaterialReadingsGeneration:
    """Called under BEGIN IMMEDIATE; compare pointer to prevent late overwrite."""
    active = await current(session, material)
    if active is not None and active.id != observed_id:
        return active
    asset = await session.scalar(
        select(MaterialReadingsGeneration).where(
            MaterialReadingsGeneration.material_id == material.id,
            MaterialReadingsGeneration.version_id == material.version_id,
            MaterialReadingsGeneration.asset_sha256 == generated.asset_sha256,
        )
    )
    if asset is None:
        asset = MaterialReadingsGeneration(
            id=new_ulid(),
            material_id=material.id,
            version_id=material.version_id,
            asset_sha256=generated.asset_sha256,
            configuration=generated.configuration,
            token_count=generated.token_count,
            payload=generated.payload,
            created_at=utc_now(),
        )
        session.add(asset)
        await session.flush()
    pointer = await session.get(MaterialReadingsCurrent, material.id)
    if pointer is None:
        session.add(MaterialReadingsCurrent(material_id=material.id, generation_id=asset.id))
    else:
        pointer.generation_id = asset.id
    return asset


async def prepare(
    session: AsyncSession,
    material_id: str,
    data: MaterialReadingsPrepare,
) -> MaterialReadingsSummary:
    from app.services.materials import bundle, require_material

    material = await require_material(session, material_id)
    if material.version_id != data.version_id:
        raise HTTPException(409, "材料版本已改变")
    active = await current(session, material)
    if active is not None and not data.force:
        return summary(active)
    observed_id = active.id if active else None
    book = await asyncio.to_thread(bundle, material)
    await session.rollback()
    generated = await build(book)
    try:
        await begin_write(session)
        material = await require_material(session, material_id)
        if material.version_id != data.version_id:
            raise HTTPException(409, "材料版本已改变")
        asset = await publish(session, material, generated, observed_id)
        result = summary(asset)
        await session.commit()
        return result
    except BaseException:
        await session.rollback()
        raise


def chapter_resources(
    payload: bytes,
    book: CompiledBook,
    chapter_id: str,
) -> list[MaterialResourceReadings]:
    chapter = next((c for c in book.chapters if c.id == chapter_id), None)
    if chapter is None:
        raise HTTPException(404, "章节不存在")
    decoded = json.loads(zlib.decompress(payload))
    resources = [MaterialResourceReadings.model_validate(r) for r in decoded["resources"]]
    result: list[MaterialResourceReadings] = []
    for resource in resources:
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


async def get_readings(
    session: AsyncSession,
    material_id: str,
    version_id: str,
    chapter_id: str,
    generation_id: str | None = None,
) -> MaterialReadingsResponse:
    from app.services.materials import bundle, require_material

    material = await require_material(session, material_id)
    if version_id != material.version_id:
        raise HTTPException(409, "材料版本已改变")
    active = (
        await session.scalar(
            select(MaterialReadingsGeneration).where(
                MaterialReadingsGeneration.id == generation_id,
                MaterialReadingsGeneration.material_id == material_id,
                MaterialReadingsGeneration.version_id == version_id,
            )
        )
        if generation_id is not None
        else await current(session, material)
    )
    if active is None:
        if generation_id is not None:
            raise HTTPException(404, "注音代次不存在")
        raise HTTPException(409, "注音尚未准备，请调用准备接口后重试")
    generation_id, payload = active.id, active.payload
    book = await asyncio.to_thread(bundle, material)
    resources = await asyncio.to_thread(chapter_resources, payload, book, chapter_id)
    return MaterialReadingsResponse(
        material_id=material_id,
        version_id=version_id,
        generation_id=generation_id,
        resources=resources,
    )
