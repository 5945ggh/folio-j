"""Explicit, serialized usage mutations with bounded same-action deduplication."""

from typing import cast

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.catalog_schemas import (
    MaterialOpenedInput,
    MaterialUsageInput,
    MaterialUsageResponse,
    ReadingStatus,
)
from app.material_models import MaterialUsage
from app.services.materials import require_material
from app.services.sources import as_utc, begin_write, utc_now


def usage_response(usage: MaterialUsage) -> MaterialUsageResponse:
    return MaterialUsageResponse(
        material_id=usage.material_id,
        status=cast(ReadingStatus, usage.status),
        revision=usage.revision,
        last_opened_at=as_utc(usage.last_opened_at) if usage.last_opened_at else None,
        updated_at=as_utc(usage.updated_at),
    )


async def get_usage(session: AsyncSession, material_id: str) -> MaterialUsageResponse:
    material = await require_material(session, material_id, with_bundle=False)
    usage = await session.get(MaterialUsage, material_id)
    if usage:
        return usage_response(usage)
    return MaterialUsageResponse(
        material_id=material_id,
        status="not_started",
        revision=0,
        last_opened_at=None,
        updated_at=as_utc(material.created_at),
    )


async def mutate_usage(
    session: AsyncSession, material_id: str, data: MaterialOpenedInput | MaterialUsageInput
) -> MaterialUsageResponse:
    try:
        await begin_write(session)
        material = await require_material(session, material_id, with_bundle=False)
        usage = await session.get(MaterialUsage, material_id)
        if usage is None:
            usage = MaterialUsage(
                material_id=material_id,
                status="not_started",
                revision=0,
                last_opened_at=None,
                last_action_id=None,
                updated_at=material.created_at,
            )
            session.add(usage)
        opened = isinstance(data, MaterialOpenedInput)
        if opened and usage.last_action_id == data.action_id:
            result = usage_response(usage)
            await session.commit()
            return result
        if usage.revision != data.expected_revision:
            raise HTTPException(409, "材料使用状态已更新，请重新读取")
        now = utc_now()
        if isinstance(data, MaterialOpenedInput):
            usage.last_action_id = data.action_id
            usage.last_opened_at = now
            if usage.status == "not_started":
                usage.status = "in_progress"
        else:
            usage.status = data.status
        usage.revision += 1
        usage.updated_at = now
        result = usage_response(usage)
        await session.commit()
        return result
    except BaseException:
        await session.rollback()
        raise
