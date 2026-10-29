"""Thin material routes; raw bounded uploads avoid multipart staging."""

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.material_schemas import (
    MaterialChapterResponse,
    MaterialIllustrationsResponse,
    MaterialImportResponse,
    MaterialResponse,
    MaterialSearchResponse,
    MaterialSummary,
    ReadingPositionResponse,
    ReadingPositionUpdate,
)
from app.material_segment_schemas import MaterialChapterSegmentsResponse
from app.metadata_schemas import MaterialDetailsResponse, MaterialMetadataUpdate
from app.readings_schemas import (
    MaterialReadingsPrepare,
    MaterialReadingsResponse,
    MaterialReadingsSummary,
)
from app.services import material_metadata, material_segments, reader_queries, readings, statistics
from app.services import materials as service
from app.statistics_schemas import MaterialStatisticsResponse

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
    "/materials/{material_id}/details",
    response_model=MaterialDetailsResponse,
    operation_id="getMaterialDetails",
)
async def get_details(material_id: str, session: Session) -> MaterialDetailsResponse:
    return await material_metadata.get_details(session, material_id)


@router.get(
    "/materials/{material_id}/statistics",
    response_model=MaterialStatisticsResponse,
    operation_id="getMaterialStatistics",
)
async def get_statistics(
    material_id: str,
    version_id: str,
    request: Request,
    generation_id: str | None = None,
) -> MaterialStatisticsResponse:
    return await statistics.get_statistics(
        request.app.state.session_factory,
        request.app.state.statistics_runtime,
        material_id,
        version_id,
        generation_id,
    )


@router.patch(
    "/materials/{material_id}/metadata",
    response_model=MaterialDetailsResponse,
    operation_id="updateMaterialMetadata",
)
async def update_metadata(
    material_id: str, data: MaterialMetadataUpdate, session: Session
) -> MaterialDetailsResponse:
    return await material_metadata.update_metadata(session, material_id, data)


@router.get(
    "/materials/{material_id}/chapters/{chapter_id}",
    response_model=MaterialChapterResponse,
    operation_id="getMaterialChapter",
)
async def get_chapter(
    material_id: str, chapter_id: str, session: Session
) -> MaterialChapterResponse:
    return await service.get_chapter(session, material_id, chapter_id)


@router.get(
    "/materials/{material_id}/chapters/{chapter_id}/segments",
    response_model=MaterialChapterSegmentsResponse,
    operation_id="listMaterialChapterSegments",
)
async def list_chapter_segments(
    material_id: str,
    chapter_id: str,
    version_id: Annotated[str, Query(min_length=1, max_length=26)],
    session: Session,
    after: Annotated[str | None, Query(pattern=r"^[0-7][0-9A-HJKMNP-TV-Z]{25}$")] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 100,
) -> MaterialChapterSegmentsResponse:
    return await material_segments.list_chapter_segments(
        session, material_id, chapter_id, version_id, after, limit
    )


@router.put(
    "/materials/{material_id}/reading-position",
    response_model=ReadingPositionResponse,
    operation_id="saveReadingPosition",
)
async def save_position(
    material_id: str, data: ReadingPositionUpdate, session: Session, request: Request
) -> ReadingPositionResponse:
    return await service.save_position(
        session, material_id, data, reader_views=request.app.state.reader_views
    )


@router.get(
    "/materials/{material_id}/search",
    response_model=MaterialSearchResponse,
    operation_id="searchMaterial",
)
async def search_material(
    material_id: str,
    session: Session,
    version_id: str,
    q: Annotated[str, Query(max_length=160)] = "",
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=100)] = 40,
) -> MaterialSearchResponse:
    return await reader_queries.search(session, material_id, version_id, q, offset, limit)


@router.get(
    "/materials/{material_id}/illustrations",
    response_model=MaterialIllustrationsResponse,
    operation_id="getMaterialIllustrations",
)
async def get_illustrations(
    material_id: str,
    session: Session,
    version_id: str,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=100)] = 40,
) -> MaterialIllustrationsResponse:
    return await reader_queries.illustrations(session, material_id, version_id, offset, limit)


@router.get(
    "/materials/{material_id}/illustrations/locate",
    response_model=MaterialIllustrationsResponse,
    operation_id="locateMaterialIllustration",
)
async def locate_illustration(
    material_id: str,
    session: Session,
    version_id: str,
    chapter_id: str,
    part_index: Annotated[int, Query(ge=0)],
    image_id: Annotated[int, Query(ge=0)],
) -> MaterialIllustrationsResponse:
    return await reader_queries.locate_illustration(
        session, material_id, version_id, chapter_id, part_index, image_id
    )


@router.get(
    "/materials/{material_id}/illustrations/{ordinal}/content",
    operation_id="getMaterialIllustrationContent",
    responses={
        200: {
            "content": {mime: {} for mime in ("image/png", "image/jpeg", "image/gif", "image/webp")}
        }
    },
    response_class=Response,
)
async def get_illustration_content(
    material_id: str,
    ordinal: Annotated[int, Path(ge=0)],
    session: Session,
    request: Request,
    version_id: str,
) -> Response:
    return await reader_queries.illustration_content(
        session, material_id, version_id, ordinal, reader_views=request.app.state.reader_views
    )


@router.post(
    "/materials/{material_id}/readings/prepare",
    response_model=MaterialReadingsSummary,
    operation_id="prepareMaterialReadings",
)
async def prepare_readings(
    material_id: str, data: MaterialReadingsPrepare, session: Session
) -> MaterialReadingsSummary:
    return await readings.prepare(session, material_id, data)


@router.get(
    "/materials/{material_id}/readings",
    response_model=MaterialReadingsResponse,
    operation_id="getMaterialReadings",
)
async def get_readings(
    material_id: str,
    version_id: str,
    chapter_id: str,
    session: Session,
    request: Request,
    generation_id: str | None = None,
) -> MaterialReadingsResponse:
    return await readings.get_readings(
        session,
        material_id,
        version_id,
        chapter_id,
        generation_id,
        reader_views=request.app.state.reader_views,
    )


@router.delete("/materials/{material_id}", status_code=204, operation_id="deleteMaterial")
async def delete_material(material_id: str, session: Session, request: Request) -> Response:
    await service.delete_material(session, material_id)
    from app.services.translations import cancel_revoked

    await cancel_revoked(request.app)
    return Response(status_code=204)
