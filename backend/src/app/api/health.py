"""Health route."""

from fastapi import APIRouter, Request

from app.jobs.supervision import workers
from app.services.health import HealthResponse, get_health

router = APIRouter(prefix="/api")


@router.get("/health", operation_id="health", response_model=HealthResponse)
def health(request: Request) -> HealthResponse:
    return get_health(workers(request.app))
