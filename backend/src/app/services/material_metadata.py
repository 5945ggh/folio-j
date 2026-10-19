"""Read-only details and serialized atomic presentation edits."""

import asyncio
import base64
import binascii
from typing import cast

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.catalog_schemas import ReadingStatus
from app.material_models import MaterialCover, MaterialCustomCover, MaterialUsage
from app.metadata_schemas import MaterialDetailsResponse, MaterialMetadataUpdate
from app.services.covers import MAX_COVER_BYTES, cover_url, valid_static_raster
from app.services.materials import bundle, require_material, summary
from app.services.sources import as_utc, begin_write, require_source


async def get_details(session: AsyncSession, material_id: str) -> MaterialDetailsResponse:
    material = await require_material(session, material_id)
    book = await asyncio.to_thread(bundle, material)
    source = await require_source(session, material.source_id)
    usage = await session.get(MaterialUsage, material_id)
    cached = await session.get(MaterialCover, material_id)
    custom = await session.get(MaterialCustomCover, material_id) is not None
    return MaterialDetailsResponse(
        **summary(material).model_dump(),
        source_title=source.title,
        cover_url=cover_url(
            material,
            custom=custom,
            cache_id=cached.material_id if cached else None,
            media_type=cached.media_type if cached else None,
            rule_version=cached.rule_version if cached else None,
        ),
        status=cast(ReadingStatus, usage.status if usage else "not_started"),
        usage_revision=usage.revision if usage else 0,
        last_opened_at=as_utc(usage.last_opened_at) if usage and usage.last_opened_at else None,
        original_title=book.title,
        chapter_count=len(book.chapters),
        metadata_revision=material.metadata_revision,
        custom_cover=custom,
    )


def decode_cover(data: MaterialMetadataUpdate) -> bytes | None:
    if data.cover is None:
        return None
    try:
        image = base64.b64decode(data.cover.data_base64, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(422, "封面须为严格 base64 图片") from exc
    if len(image) > MAX_COVER_BYTES:
        raise HTTPException(422, "封面超过 4 MiB")
    if not valid_static_raster(image, data.cover.media_type):
        raise HTTPException(422, "封面须为有效静态 PNG／JPEG，且不超过 1600 万像素")
    return image


async def update_metadata(
    session: AsyncSession, material_id: str, data: MaterialMetadataUpdate
) -> MaterialDetailsResponse:
    image = await asyncio.to_thread(decode_cover, data)
    try:
        await begin_write(session)
        material = await require_material(session, material_id, with_bundle=False)
        if material.metadata_revision != data.expected_revision:
            raise HTTPException(409, "书籍信息已更新，请重新读取")
        material.title = data.title
        material.metadata_revision += 1
        if data.cover_action != "keep":
            custom = await session.get(MaterialCustomCover, material_id)
            if data.cover_action == "reset":
                if custom is not None:
                    await session.delete(custom)
            elif data.cover is not None and image is not None:
                if custom is None:
                    custom = MaterialCustomCover(material_id=material_id)
                    session.add(custom)
                custom.media_type = data.cover.media_type
                custom.data = image
        details = await get_details(session, material_id)
        await session.commit()
    except BaseException:
        await session.rollback()
        raise
    return details
