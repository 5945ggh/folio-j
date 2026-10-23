"""Thin independent translation routes."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.services import translations as service
from app.services.chapter_translations import list_chapter_translations
from app.translation_schemas import (
    MaterialChapterTranslations,
    TranslationAdopt,
    TranslationAdoptionResponse,
    TranslationCreate,
    TranslationDeleteImpact,
    TranslationHistoryResponse,
    TranslationResultResponse,
    TranslationSettingsResponse,
    TranslationSettingsUpdate,
    TranslationTaskResponse,
)

router = APIRouter(prefix="/api")
Session = Annotated[AsyncSession, Depends(get_session)]


@router.get(
    "/materials/{material_id}/chapters/{chapter_id}/translations",
    response_model=MaterialChapterTranslations,
)
async def chapter_translations(
    material_id: str,
    chapter_id: str,
    session: Session,
    version_id: str = Query(min_length=1, max_length=26),
    after: str | None = Query(default=None, min_length=1, max_length=2048),
    limit: int = Query(default=100, ge=1, le=100),
) -> MaterialChapterTranslations:
    return await list_chapter_translations(
        session, material_id, chapter_id, version_id, after, limit
    )


@router.get("/settings/translation", response_model=TranslationSettingsResponse)
async def get_translation_settings(session: Session) -> TranslationSettingsResponse:
    return await service.get_settings(session)


@router.put("/settings/translation", response_model=TranslationSettingsResponse)
async def put_translation_settings(
    data: TranslationSettingsUpdate, session: Session
) -> TranslationSettingsResponse:
    return await service.put_settings(session, data)


@router.post("/materials/{material_id}/translations", response_model=TranslationTaskResponse)
async def create_translation(
    material_id: str, data: TranslationCreate, session: Session, request: Request
) -> TranslationTaskResponse:
    result = await service.accept(session, material_id, data)
    service.wake(request.app)
    return result


@router.get("/materials/{material_id}/translations", response_model=TranslationHistoryResponse)
async def translation_history(
    material_id: str,
    session: Session,
    offset: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=50),
    identity_sha256: str | None = None,
) -> TranslationHistoryResponse:
    return await service.history(session, material_id, offset, limit, identity_sha256)


@router.get("/translation-tasks/{task_id}", response_model=TranslationTaskResponse)
async def get_translation_task(task_id: str, session: Session) -> TranslationTaskResponse:
    return await service.get_task(session, task_id)


@router.post("/translation-tasks/{task_id}/stop", response_model=TranslationTaskResponse)
async def stop_translation(
    task_id: str, session: Session, request: Request
) -> TranslationTaskResponse:
    result = await service.stop(session, task_id)
    service.cancel(request.app, task_id)
    return result


@router.get("/translation-results/{result_id}", response_model=TranslationResultResponse)
async def get_translation_result(result_id: str, session: Session) -> TranslationResultResponse:
    return await service.get_result(session, result_id)


@router.post("/translation-results/{result_id}/adopt", response_model=TranslationAdoptionResponse)
async def adopt_translation(
    result_id: str, data: TranslationAdopt, session: Session
) -> TranslationAdoptionResponse:
    return await service.adopt(session, result_id, data)


@router.get(
    "/segments/{segment_id}/translation-results", response_model=list[TranslationResultResponse]
)
async def segment_translations(
    segment_id: str, session: Session
) -> list[TranslationResultResponse]:
    return await service.segment_results(session, segment_id)


@router.get("/materials/{material_id}/delete-impact", response_model=TranslationDeleteImpact)
async def material_translation_delete_impact(
    material_id: str, session: Session
) -> TranslationDeleteImpact:
    return await service.delete_impact(session, material_id)
