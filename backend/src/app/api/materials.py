"""Thin material routes; raw bounded uploads avoid multipart staging."""

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.material_schemas import (
    MaterialChapterResponse,
    MaterialImportResponse,
    MaterialResponse,
    MaterialSummary,
    ReadingPositionResponse,
    ReadingPositionUpdate,
)
from app.services import materials as service

router = APIRouter(prefix="/api")
Session = Annotated[AsyncSession, Depends(get_session)]


@router.get(
    "/sources/{source_id}/materials",
    response_model=list[MaterialSummary],
    operation_id="listMaterials",
)
async def list_materials(source_id: str, session: Session) -> list[MaterialSummary]:
    return await service.list_materials(session, source_id)


@router.post(
    "/sources/{source_id}/materials",
    response_model=MaterialImportResponse,
    operation_id="importMaterial",
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/epub+zip": {"schema": {"type": "string", "format": "binary"}}},
        }
    },
)
async def import_material(
    source_id: str, request: Request, session: Session, filename: str | None = None
) -> MaterialImportResponse:
    return await service.import_material(session, source_id, request)


@router.get("/materials/{material_id}", response_model=MaterialResponse, operation_id="getMaterial")
async def get_material(material_id: str, session: Session) -> MaterialResponse:
    return await service.get_material(session, material_id)


@router.get(
    "/materials/{material_id}/chapters/{chapter_id}",
    response_model=MaterialChapterResponse,
    operation_id="getMaterialChapter",
)
async def get_chapter(
    material_id: str, chapter_id: str, session: Session
) -> MaterialChapterResponse:
    return await service.get_chapter(session, material_id, chapter_id)


@router.put(
    "/materials/{material_id}/reading-position",
    response_model=ReadingPositionResponse,
    operation_id="saveReadingPosition",
)
async def save_position(
    material_id: str, data: ReadingPositionUpdate, session: Session
) -> ReadingPositionResponse:
    return await service.save_position(session, material_id, data)
