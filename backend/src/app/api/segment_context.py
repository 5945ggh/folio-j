"""Independent learning-context settings; writes never touch learning records."""

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.segment_context_schemas import SegmentContextSettingsResponse, SegmentContextSettingsUpdate
from app.services import segment_context_settings as service

router = APIRouter(prefix="/settings/segment-context")
Session = Annotated[AsyncSession, Depends(get_session)]


@router.get(
    "", response_model=SegmentContextSettingsResponse, operation_id="getSegmentContextSettings"
)
async def get_settings(session: Session) -> SegmentContextSettingsResponse:
    return await service.get_settings(session)


@router.put(
    "", response_model=SegmentContextSettingsResponse, operation_id="saveSegmentContextSettings"
)
async def save_settings(
    data: SegmentContextSettingsUpdate, session: Session
) -> SegmentContextSettingsResponse:
    return await service.save_settings(session, data)
