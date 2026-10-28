"""Local health status."""

from collections.abc import Mapping
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.jobs.supervision import BackgroundWorker, WorkerName, WorkerStatus


class WorkerHealth(BaseModel):
    status: WorkerStatus
    active_tasks: int
    failure_count: int
    last_error: str | None
    last_failure_at: datetime | None


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    workers: dict[str, WorkerHealth]


def get_health(workers: Mapping[WorkerName, BackgroundWorker]) -> HealthResponse:
    states = {
        name: WorkerHealth(
            status=worker.status,
            active_tasks=len(worker.tasks),
            failure_count=worker.failures,
            last_error=worker.last_error,
            last_failure_at=worker.last_failure_at,
        )
        for name, worker in workers.items()
    }
    return HealthResponse(
        status=(
            "degraded"
            if any(state.status in ("retrying", "stopped") for state in states.values())
            else "ok"
        ),
        workers=states,
    )
