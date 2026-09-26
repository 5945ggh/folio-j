"""Health route."""

from fastapi import APIRouter

from app.services.health import HealthResponse, get_health

router = APIRouter(prefix="/api")


@router.get("/health", operation_id="health", response_model=HealthResponse)
def health() -> HealthResponse:
    return get_health()
