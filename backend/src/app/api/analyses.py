"""Read Analysis documents and user-managed whole-document deletion."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.analysis_schemas import AnalysisDeleteImpact, AnalysisDetail, AnalysisListItem
from app.db import get_session
from app.services import analyses as service

router = APIRouter(prefix="/api")
Session = Annotated[AsyncSession, Depends(get_session)]


@router.get(
    "/segments/{segment_id}/analyses",
    response_model=list[AnalysisListItem],
    operation_id="listAnalyses",
)
async def list_analyses(
    segment_id: str,
    session: Session,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> list[AnalysisListItem]:
    return await service.list_analyses(session, segment_id, limit=limit, offset=offset)


@router.get("/analyses/{analysis_id}", response_model=AnalysisDetail, operation_id="getAnalysis")
async def get_analysis(
    analysis_id: str, session: Session, revision_id: str | None = None
) -> AnalysisDetail:
    return await service.get_analysis(session, analysis_id, revision_id)


@router.get(
    "/analyses/{analysis_id}/delete-impact",
    response_model=AnalysisDeleteImpact,
    operation_id="getAnalysisDeleteImpact",
)
async def get_delete_impact(analysis_id: str, session: Session) -> AnalysisDeleteImpact:
    return await service.delete_impact(session, analysis_id)


@router.delete(
    "/analyses/{analysis_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteAnalysis",
)
async def delete_analysis(analysis_id: str, session: Session) -> None:
    await service.delete_analysis(session, analysis_id)
