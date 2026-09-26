"""Local health status."""

from typing import Literal

from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: Literal["ok"]


def get_health() -> HealthResponse:
    return HealthResponse(status="ok")
