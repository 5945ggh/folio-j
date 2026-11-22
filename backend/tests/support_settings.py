from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.db import Base, create_engine
from app.main import create_app


@pytest.fixture(autouse=True)
def offline_discovery(monkeypatch: pytest.MonkeyPatch) -> None:
    async def no_models(_url: str, _key: str | None) -> list[str]:
        return []

    monkeypatch.setattr("app.llm.adapters.discover_models", no_models)


@asynccontextmanager
async def settings_app_client(database: Path) -> AsyncGenerator[tuple[AsyncClient, FastAPI], None]:
    engine = create_engine(database)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
    finally:
        await engine.dispose()
    application = create_app(database_path=database)
    application.state.verification_worker_enabled = False
    async with application.router.lifespan_context(application):
        async with AsyncClient(
            transport=ASGITransport(app=application), base_url="http://test"
        ) as client:
            yield client, application


@asynccontextmanager
async def settings_client(database: Path) -> AsyncGenerator[AsyncClient, None]:
    async with settings_app_client(database) as (client, _application):
        yield client


def provider_payload(**changes: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "name": "本地测试",
        "base_url": "http://localhost:8765/v1",
        "protocol": "chat_completions",
        "enabled": True,
    }
    payload.update(changes)
    return payload


async def create_provider(client: AsyncClient, **changes: object) -> dict[str, Any]:
    response = await client.post("/api/providers", json=provider_payload(**changes))
    assert response.status_code == 201, response.text
    return response.json()
