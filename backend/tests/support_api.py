"""Shared isolated API clients and explicit offline chat fixtures."""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.db import Base, create_engine
from app.main import create_app


@asynccontextmanager
async def api_client(database: Path) -> AsyncGenerator[AsyncClient, None]:
    """Create schema explicitly; ASGITransport does not run lifespan itself."""
    engine = create_engine(database)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
    finally:
        await engine.dispose()
    application = create_app(database_path=database)
    async with application.router.lifespan_context(application):
        async with AsyncClient(
            transport=ASGITransport(app=application), base_url="http://test"
        ) as client:
            yield client


def assert_utc_timestamp(value: str) -> None:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    assert parsed.tzinfo is not None
    offset = parsed.utcoffset()
    assert offset is not None and offset.total_seconds() == 0


@pytest.fixture(autouse=True)
def offline_chat_discovery(monkeypatch: pytest.MonkeyPatch) -> None:
    async def discover(_url: str, _key: str | None) -> list[str]:
        return ["offline-model"]

    monkeypatch.setattr("app.llm.adapters.discover_models", discover)


@asynccontextmanager
async def chat_client(database: Path) -> AsyncGenerator[tuple[AsyncClient, FastAPI], None]:
    engine = create_engine(database)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
    finally:
        await engine.dispose()
    app = create_app(database_path=database)
    app.state.chat_worker_enabled = False
    app.state.verification_worker_enabled = False
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            yield client, app


async def seed_chat(client: AsyncClient) -> dict[str, Any]:
    source = await client.post(
        "/api/sources", json={"title": "原作", "description": "来源说明", "note": "私有管理备注"}
    )
    assert source.status_code == 201, source.text
    source_id = source.json()["id"]
    segment = await client.post(
        f"/api/sources/{source_id}/segments",
        json={"text": "昨日は雨だった。", "context_before": "朝のこと。", "note": "片段管理备注"},
    )
    assert segment.status_code == 201, segment.text
    provider = await client.post(
        "/api/providers",
        json={
            "name": "离线服务",
            "base_url": "http://localhost:9999/v1",
            "protocol": "chat_completions",
            "api_key": "fictional-chat-secret",
        },
    )
    assert provider.status_code == 201, provider.text
    model = await client.post(
        f"/api/providers/{provider.json()['id']}/models", json={"model_id": "offline-model"}
    )
    assert model.status_code == 201, model.text
    settings = (await client.get("/api/settings")).json()
    defaults = {**settings["defaults"], "chat_model_id": model.json()["id"]}
    assert (await client.put("/api/settings/defaults", json=defaults)).status_code == 200
    created = await client.post(
        f"/api/segments/{segment.json()['id']}/threads", json={"request_id": str(uuid4())}
    )
    assert created.status_code == 201, created.text
    return {
        "source": source.json(),
        "segment": segment.json(),
        "provider": provider.json(),
        "model": model.json(),
        "thread": created.json(),
        "settings": settings,
    }


def question_payload(seed: dict[str, Any], **changes: Any) -> dict[str, Any]:
    return {
        "request_id": str(uuid4()),
        "expected_thread_revision": seed["thread"]["revision"],
        "expected_segment_revision": seed["segment"]["revision"],
        "question": "だった是什么意思？",
        "stream": True,
        **changes,
    }


async def accept(client: AsyncClient, seed: dict[str, Any], **changes: Any) -> dict[str, Any]:
    response = await client.post(
        f"/api/threads/{seed['thread']['id']}/jobs", json=question_payload(seed, **changes)
    )
    assert response.status_code == 202, response.text
    return response.json()
