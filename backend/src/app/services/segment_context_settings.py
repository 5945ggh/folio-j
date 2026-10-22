"""Read defaults and serialize compare-and-swap writes for this settings group."""

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.segment_context_models import SegmentContextPreferences
from app.segment_context_schemas import (
    DEFAULT_SEGMENT_CONTEXT,
    SegmentContextSettingsResponse,
    SegmentContextSettingsUpdate,
)


def response(row: SegmentContextPreferences | None) -> SegmentContextSettingsResponse:
    if row is None:
        return DEFAULT_SEGMENT_CONTEXT.model_copy()
    return SegmentContextSettingsResponse.model_validate(row, from_attributes=True)


async def get_settings(session: AsyncSession) -> SegmentContextSettingsResponse:
    return response(await session.get(SegmentContextPreferences, 1))


async def save_settings(
    session: AsyncSession, data: SegmentContextSettingsUpdate
) -> SegmentContextSettingsResponse:
    try:
        await session.execute(text("BEGIN IMMEDIATE"))
        row = await session.get(SegmentContextPreferences, 1)
        current = response(row)
        if data.expected_revision != current.revision:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "settings_conflict",
                    "message": "语境设置已更新，请读取最新配置后重试。",
                },
            )
        values = data.model_dump(exclude={"expected_revision"})
        if row is None:
            row = SegmentContextPreferences(id=1, revision=current.revision + 1, **values)
            session.add(row)
        else:
            for key, value in values.items():
                setattr(row, key, value)
            row.revision = current.revision + 1
        result = response(row)
        await session.commit()
        return result
    except BaseException:
        await session.rollback()
        raise
