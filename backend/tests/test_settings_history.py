"""Verification history filters durable snapshot identities before pagination."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from test_settings_api import (
    create_provider,
    settings_app_client,
)
from test_settings_api import (
    offline_discovery as offline_discovery,
)

from app.settings_models import Run


@pytest.mark.asyncio
async def test_run_filters_identity_status_pagination_and_deleted_registry(tmp_path: Path) -> None:
    async with settings_app_client(tmp_path / "folio.db") as (client, application):
        first = await create_provider(client, name="first")
        second = await create_provider(client, name="second")
        models: list[str] = []
        for provider in (first, second):
            response = await client.post(
                f"/api/providers/{provider['id']}/models", json={"model_id": "shared"}
            )
            models.append(response.json()["id"])
        run_ids: list[str] = []
        statuses = [
            "succeeded",
            "failed",
            "interrupted",
            "succeeded",
            "failed",
            "succeeded",
            "succeeded",
        ]
        for index, status in enumerate(statuses):
            model_id = models[1] if index == 5 else models[0]
            accepted = await client.post(
                f"/api/provider-models/{model_id}/verifications", json={"stream": False}
            )
            assert accepted.status_code == 202, accepted.text
            run_id = accepted.json()["id"]
            run_ids.append(run_id)
            async with application.state.session_factory() as session:
                row = await session.get(Run, run_id)
                assert row is not None
                row.status = status
                row.created_at = datetime(2026, 1, 1, tzinfo=UTC) + timedelta(seconds=index)
                if index == 4:
                    row.deleted_at = row.created_at
                if index == 6:
                    row.purpose = "chat"
                await session.commit()

        async def ids(**params: str | int) -> list[str]:
            response = await client.get("/api/runs", params=params)
            assert response.status_code == 200, response.text
            return [row["id"] for row in response.json()]

        assert await ids(provider_id=first["id"]) == list(reversed(run_ids[:4]))
        assert await ids(model_id=models[0]) == list(reversed(run_ids[:4]))
        assert await ids(model_id="shared") == []
        assert await ids(status="failed") == [run_ids[1]]
        assert await ids(status="interrupted") == [run_ids[2]]
        assert await ids(status="queued") == []
        assert await ids(status="running") == []
        assert await ids(provider_id=first["id"], model_id=models[1]) == []
        filters = {"provider_id": first["id"], "model_id": models[0], "status": "succeeded"}
        assert await ids(**filters, limit=1) == [run_ids[3]]
        assert await ids(**filters, limit=1, offset=1) == [run_ids[0]]
        assert await ids(**filters, offset=2) == []
        assert (await client.get("/api/runs", params={"status": "invalid"})).status_code == 422
        assert (await client.get("/api/runs", params={"status": ""})).status_code == 422
        assert (await client.delete(f"/api/provider-models/{models[0]}")).status_code == 204
        assert (await client.delete(f"/api/providers/{first['id']}")).status_code == 204
        assert await ids(**filters) == [run_ids[3], run_ids[0]]
        for run_id in run_ids[:4]:
            response = await client.get(f"/api/runs/{run_id}")
            assert response.status_code == 200, response.text
            assert response.json()["model_id"] == "shared"
        assert (await client.get(f"/api/runs/{run_ids[4]}")).status_code == 404
