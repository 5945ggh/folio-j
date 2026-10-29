"""Read defaults and serialize compare-and-swap writes for this settings group."""

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.context_copy_models import ContextCopyPreferences
from app.context_copy_schemas import (
    DEFAULT_CONTEXT_COPY,
    ContextCopySettingsResponse,
    ContextCopySettingsUpdate,
)


def response(row: ContextCopyPreferences | None) -> ContextCopySettingsResponse:
    if row is None:
        return DEFAULT_CONTEXT_COPY.model_copy()
    return ContextCopySettingsResponse.model_validate(row, from_attributes=True)


async def get_settings(session: AsyncSession) -> ContextCopySettingsResponse:
    return response(await session.get(ContextCopyPreferences, 1))


async def save_settings(
    session: AsyncSession, data: ContextCopySettingsUpdate
) -> ContextCopySettingsResponse:
    try:
        await session.execute(text("BEGIN IMMEDIATE"))
        row = await session.get(ContextCopyPreferences, 1)
        current = response(row)
        if data.expected_revision != current.revision:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "settings_conflict",
                    "message": "带上下文复制设置已更新，请读取最新配置后重试。",
                },
            )
        values = data.model_dump(exclude={"expected_revision"})
        if row is None:
            row = ContextCopyPreferences(id=1, revision=current.revision + 1, **values)
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
