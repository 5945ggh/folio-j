"""Thin Source and Segment HTTP routes."""

from typing import Annotated

from fastapi import APIRouter, Depends, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.provenance_schemas import MaterialProvenance, SegmentProvenanceResponse
from app.schemas import (
    SegmentCreate,
    SegmentDeleteImpact,
    SegmentExplanationPromptResponse,
    SegmentProvenanceMatches,
    SegmentResponse,
    SegmentUpdate,
    SourceCreate,
    SourceDeleteImpact,
    SourceResponse,
    SourceUpdate,
)
from app.services import explanation_prompts, material_provenance
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
async def delete_source(source_id: str, session: Session, request: Request) -> None:
    cancelled = await service.delete_source(
        session, source_id, request.app.state.chat_dispatch_lock
    )
    from app.jobs.runtime import request_chat_cancel
    from app.services.translations import cancel_revoked

    await cancel_revoked(request.app)
    for job_id in cancelled:
        request_chat_cancel(request.app, job_id)


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


@router.get(
    "/segments/{segment_id}/explanation-prompt",
    response_model=SegmentExplanationPromptResponse,
    operation_id="getSegmentExplanationPrompt",
)
async def get_segment_explanation_prompt(
    segment_id: str, session: Session
) -> SegmentExplanationPromptResponse:
    return await explanation_prompts.for_segment(session, segment_id)


@router.patch(
    "/segments/{segment_id}", response_model=SegmentResponse, operation_id="updateSegment"
)
async def update_segment(segment_id: str, data: SegmentUpdate, session: Session) -> SegmentResponse:
    return await service.update_segment(session, segment_id, data)


@router.get(
    "/segments/{segment_id}/delete-impact",
    response_model=SegmentDeleteImpact,
    operation_id="getSegmentDeleteImpact",
)
async def segment_delete_impact(segment_id: str, session: Session) -> SegmentDeleteImpact:
    return await service.segment_delete_impact(session, segment_id)


@router.delete(
    "/segments/{segment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteSegment",
)
async def delete_segment(segment_id: str, session: Session, request: Request) -> None:
    cancelled = await service.delete_segment(
        session, segment_id, request.app.state.chat_dispatch_lock
    )
    from app.jobs.runtime import request_chat_cancel

    for job_id in cancelled:
        request_chat_cancel(request.app, job_id)


@router.get(
    "/segments/{segment_id}/material-provenance",
    response_model=SegmentProvenanceResponse,
    operation_id="getSegmentMaterialProvenance",
)
async def get_segment_material_provenance(
    segment_id: str,
    session: Session,
) -> SegmentProvenanceResponse:
    return await material_provenance.resolve(session, segment_id)


@router.post(
    "/sources/{source_id}/segments/material-provenance/matches",
    response_model=SegmentProvenanceMatches,
    operation_id="matchSegmentMaterialProvenance",
)
async def match_segment_material_provenance(
    source_id: str,
    data: MaterialProvenance,
    session: Session,
) -> SegmentProvenanceMatches:
    return await material_provenance.matches(session, source_id, data)


@router.post(
    "/segments/{segment_id}/material-provenance/select",
    response_model=SegmentResponse,
    operation_id="selectSegmentMaterialProvenance",
)
async def select_segment_material_provenance(
    segment_id: str,
    data: MaterialProvenance,
    session: Session,
) -> SegmentResponse:
    return await material_provenance.select_existing(session, segment_id, data)
