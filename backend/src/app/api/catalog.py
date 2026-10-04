"""Thin presentation catalog and explicit usage routes; old list APIs remain unchanged."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.catalog_schemas import (
    AnalysisCatalogPage,
    MaterialCatalogPage,
    MaterialOpenedInput,
    MaterialUsageInput,
    MaterialUsageResponse,
    ReadingStatus,
    SegmentCatalogPage,
    SourceCatalogPage,
)
from app.db import get_session
from app.services import catalog, covers, material_usage

router = APIRouter(prefix="/api")
Session = Annotated[AsyncSession, Depends(get_session)]
Page = Annotated[int, Query(ge=1)]
Size = Annotated[int, Query(ge=1, le=100)]
Order = Literal["asc", "desc"]


@router.get("/materials", response_model=MaterialCatalogPage, operation_id="getMaterialCatalog")
async def materials(
    session: Session,
    type: Literal["book"] = "book",
    source_id: str | None = None,
    q: str = "",
    status: ReadingStatus | None = None,
    sort: Literal["title", "created_at", "last_opened_at"] = "title",
    order: Order = "asc",
    page: Page = 1,
    page_size: Size = 50,
) -> MaterialCatalogPage:
    return await catalog.material_catalog(
        session, source_id, q, status, sort, order, page, page_size
    )


@router.get("/catalog/sources", response_model=SourceCatalogPage, operation_id="getSourceCatalog")
async def sources(
    session: Session,
    q: str = "",
    sort: Literal["title", "created_at", "updated_at"] = "title",
    order: Order = "asc",
    page: Page = 1,
    page_size: Size = 50,
) -> SourceCatalogPage:
    return await catalog.source_catalog(session, q, sort, order, page, page_size)


@router.get(
    "/sources/{source_id}/catalog/segments",
    response_model=SegmentCatalogPage,
    operation_id="getSegmentCatalog",
)
async def segments(
    source_id: str,
    session: Session,
    q: str = "",
    sort: Literal["created_at", "updated_at"] = "created_at",
    order: Order = "desc",
    page: Page = 1,
    page_size: Size = 50,
) -> SegmentCatalogPage:
    return await catalog.segment_catalog(session, source_id, q, sort, order, page, page_size)


@router.get(
    "/sources/{source_id}/catalog/analyses",
    response_model=AnalysisCatalogPage,
    operation_id="getAnalysisCatalog",
)
async def analyses(
    source_id: str,
    session: Session,
    q: str = "",
    sort: Literal["title", "created_at", "updated_at"] = "title",
    order: Order = "asc",
    page: Page = 1,
    page_size: Size = 50,
) -> AnalysisCatalogPage:
    return await catalog.analysis_catalog(session, source_id, q, sort, order, page, page_size)


@router.get(
    "/materials/{material_id}/usage",
    response_model=MaterialUsageResponse,
    operation_id="getMaterialUsage",
)
async def usage(material_id: str, session: Session) -> MaterialUsageResponse:
    return await material_usage.get_usage(session, material_id)


@router.post(
    "/materials/{material_id}/opened",
    response_model=MaterialUsageResponse,
    operation_id="recordMaterialOpened",
)
async def opened(
    material_id: str, data: MaterialOpenedInput, session: Session
) -> MaterialUsageResponse:
    return await material_usage.mutate_usage(session, material_id, data)


@router.put(
    "/materials/{material_id}/usage",
    response_model=MaterialUsageResponse,
    operation_id="setMaterialUsage",
)
async def set_usage(
    material_id: str, data: MaterialUsageInput, session: Session
) -> MaterialUsageResponse:
    return await material_usage.mutate_usage(session, material_id, data)


@router.get(
    "/materials/{material_id}/cover",
    operation_id="getMaterialCover",
    responses={
        200: {"content": {"image/png": {}, "image/jpeg": {}}},
        404: {"description": "无可用封面或材料不可见"},
    },
)
async def cover(material_id: str, session: Session) -> Response:
    data, media_type = await covers.get_cover(session, material_id)
    return Response(
        data,
        media_type=media_type,
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )
