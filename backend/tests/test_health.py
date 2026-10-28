from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from test_chat_api import chat_client
from test_source_segment import api_client

from app.main import create_app


@pytest.mark.asyncio
async def test_health_contract() -> None:
    async with AsyncClient(
        transport=ASGITransport(app=create_app()), base_url="http://test"
    ) as client:
        response = await client.get("/api/health")
        assert response.status_code == 200
        assert response.json() == {
            "status": "degraded",
            "workers": {
                name: {
                    "status": "stopped",
                    "active_tasks": 0,
                    "failure_count": 0,
                    "last_error": None,
                    "last_failure_at": None,
                }
                for name in ("chat", "translation", "verification")
            },
        }
        contract = (await client.get("/api/openapi.json")).json()
        operation = contract["paths"]["/api/health"]["get"]
        assert operation["operationId"] == "health"
        assert (
            operation["responses"]["200"]["content"]["application/json"]["schema"]["$ref"]
            == "#/components/schemas/HealthResponse"
        )


@pytest.mark.asyncio
async def test_running_workers_are_healthy(tmp_path: Path) -> None:
    async with api_client(tmp_path / "healthy.db") as client:
        state = (await client.get("/api/health")).json()
        assert state["status"] == "ok"
        assert set(state["workers"]) == {"chat", "translation", "verification"}
        assert all(worker["status"] == "healthy" for worker in state["workers"].values())


@pytest.mark.asyncio
async def test_explicitly_disabled_workers_are_not_reported_as_broken(tmp_path: Path) -> None:
    async with chat_client(tmp_path / "disabled.db") as (client, _app):
        state = (await client.get("/api/health")).json()
        assert state["status"] == "ok"
        assert all(worker["status"] == "disabled" for worker in state["workers"].values())


@pytest.mark.asyncio
async def test_docs_available() -> None:
    async with AsyncClient(
        transport=ASGITransport(app=create_app()), base_url="http://test"
    ) as client:
        assert (await client.get("/api/docs")).status_code == 200
