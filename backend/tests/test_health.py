import pytest
from httpx import ASGITransport, AsyncClient

from app.main import create_app


@pytest.mark.asyncio
async def test_health_contract() -> None:
    async with AsyncClient(
        transport=ASGITransport(app=create_app()), base_url="http://test"
    ) as client:
        response = await client.get("/api/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}
        contract = (await client.get("/api/openapi.json")).json()
        operation = contract["paths"]["/api/health"]["get"]
        assert operation["operationId"] == "health"
        assert (
            operation["responses"]["200"]["content"]["application/json"]["schema"]["$ref"]
            == "#/components/schemas/HealthResponse"
        )


@pytest.mark.asyncio
async def test_docs_available() -> None:
    async with AsyncClient(
        transport=ASGITransport(app=create_app()), base_url="http://test"
    ) as client:
        assert (await client.get("/api/docs")).status_code == 200
