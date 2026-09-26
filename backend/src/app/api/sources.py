"""Thin Source and Segment HTTP routes."""

from typing import Annotated

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.schemas import (
    SegmentCreate,
    SegmentResponse,
    SegmentUpdate,
    SourceCreate,
    SourceDeleteImpact,
    SourceResponse,
    SourceUpdate,
)
from app.services import sources as service

router = APIRouter(prefix="/api")
Session = Annotated[AsyncSession, Depends(get_session)]


@router.get("/sources", response_model=list[SourceResponse], operation_id="listSources")
async def list_sources(session: Session) -> list[SourceResponse]:
    return await service.list_sources(session)


@router.post(
    "/sources",
    response_model=SourceResponse,
    status_code=status.HTTP_201_CREATED,
    operation_id="createSource",
)
async def create_source(data: SourceCreate, session: Session) -> SourceResponse:
    return await service.create_source(session, data)


@router.get("/sources/{source_id}", response_model=SourceResponse, operation_id="getSource")
async def get_source(source_id: str, session: Session) -> SourceResponse:
    return await service.get_source(session, source_id)


@router.patch("/sources/{source_id}", response_model=SourceResponse, operation_id="updateSource")
async def update_source(source_id: str, data: SourceUpdate, session: Session) -> SourceResponse:
    return await service.update_source(session, source_id, data)


@router.get(
    "/sources/{source_id}/delete-impact",
    response_model=SourceDeleteImpact,
    operation_id="getSourceDeleteImpact",
)
async def source_delete_impact(source_id: str, session: Session) -> SourceDeleteImpact:
    return await service.source_delete_impact(session, source_id)


@router.delete(
    "/sources/{source_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteSource",
)
async def delete_source(source_id: str, session: Session) -> None:
    await service.delete_source(session, source_id)


@router.get(
    "/sources/{source_id}/segments",
    response_model=list[SegmentResponse],
    operation_id="listSegments",
)
async def list_segments(source_id: str, session: Session) -> list[SegmentResponse]:
    return await service.list_segments(session, source_id)


@router.post(
    "/sources/{source_id}/segments",
    response_model=SegmentResponse,
    status_code=status.HTTP_201_CREATED,
    operation_id="createSegment",
)
async def create_segment(source_id: str, data: SegmentCreate, session: Session) -> SegmentResponse:
    return await service.create_segment(session, source_id, data)


@router.get("/segments/{segment_id}", response_model=SegmentResponse, operation_id="getSegment")
async def get_segment(segment_id: str, session: Session) -> SegmentResponse:
    return await service.get_segment(session, segment_id)


@router.patch(
    "/segments/{segment_id}", response_model=SegmentResponse, operation_id="updateSegment"
)
async def update_segment(segment_id: str, data: SegmentUpdate, session: Session) -> SegmentResponse:
    return await service.update_segment(session, segment_id, data)


@router.delete(
    "/segments/{segment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteSegment",
)
async def delete_segment(segment_id: str, session: Session) -> None:
    await service.delete_segment(session, segment_id)
