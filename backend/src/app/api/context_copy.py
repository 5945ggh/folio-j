"""Context-copy defaults; writes never touch learning records."""

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.context_copy_schemas import ContextCopySettingsResponse, ContextCopySettingsUpdate
from app.db import get_session
from app.services import context_copy_settings as service

router = APIRouter(prefix="/settings/context-copy")
Session = Annotated[AsyncSession, Depends(get_session)]


@router.get("", response_model=ContextCopySettingsResponse, operation_id="getContextCopySettings")
async def get_settings(session: Session) -> ContextCopySettingsResponse:
    return await service.get_settings(session)


@router.put("", response_model=ContextCopySettingsResponse, operation_id="saveContextCopySettings")
async def save_settings(
    data: ContextCopySettingsUpdate, session: Session
) -> ContextCopySettingsResponse:
    return await service.save_settings(session, data)
