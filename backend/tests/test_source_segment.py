"""First-slice contracts against an isolated SQLite database."""

import re
import sqlite3
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from alembic.config import Config
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from alembic import command
from app.db import Base, create_engine
from app.main import create_app
from app.models import Segment

ULID = re.compile(r"^[0-7][0-9A-HJKMNP-TV-Z]{25}$")
OPTIONAL_SEGMENT_FIELDS = (
    "translation",
    "context_before",
    "context_after",
    "transcription",
    "note",
    "source_ref",
)


def test_openapi_update_fields_are_optional_but_non_nullable() -> None:
    """Generated clients must not advertise null values rejected by the API."""
    schemas = create_app().openapi()["components"]["schemas"]
    for model, fields in (
        ("SourceUpdate", ("title", "description", "note")),
        ("SegmentUpdate", ("text", *OPTIONAL_SEGMENT_FIELDS)),
    ):
        schema = schemas[model]
        assert "required" not in schema
        for field in fields:
            property_schema = schema["properties"][field]
            assert property_schema.get("type") == "string", (model, field, property_schema)


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


@pytest.mark.asyncio
async def test_create_edit_reload_and_persist_sources_and_segments(tmp_path: Path) -> None:
    database = tmp_path / "folio.db"
    async with api_client(database) as client:
        created = await client.post(
            "/api/sources",
            json={"title": "  か\u3099く  ", "description": "説明\nか\u3099", "note": "めも"},
        )
        assert created.status_code == 201, created.text
        source = created.json()
        assert ULID.fullmatch(source["id"])
        assert source["title"] == "がく"
        assert source["description"] == "説明\nが"
        assert source["note"] == "めも"
        assert source["segment_count"] == 0
        assert_utc_timestamp(source["created_at"])
        assert_utc_timestamp(source["updated_at"])

        other = await client.post("/api/sources", json={"title": "別の素材"})
        assert other.status_code == 201, other.text
        other_source = other.json()
        assert other_source["description"] == other_source["note"] == ""
        source_list = (await client.get("/api/sources")).json()
        assert {item["id"] for item in source_list} == {
            source["id"],
            other_source["id"],
        }
        assert source_list == sorted(
            source_list, key=lambda item: (item["created_at"], item["id"]), reverse=True
        )

        text = "  か\u3099\nく  "
        first = await client.post(
            f"/api/sources/{source['id']}/segments",
            json={"text": text, "translation": "訳\nか\u3099"},
        )
        assert first.status_code == 201, first.text
        segment = first.json()
        assert ULID.fullmatch(segment["id"])
        assert segment["source_id"] == source["id"]
        assert segment["text"] == "  が\nく  "
        assert segment["translation"] == "訳\nが"
        assert segment["text_locked_at"] is None
        assert_utc_timestamp(segment["created_at"])
        assert_utc_timestamp(segment["updated_at"])
        for field in OPTIONAL_SEGMENT_FIELDS:
            if field != "translation":
                assert segment[field] == ""

        second = await client.post(f"/api/sources/{source['id']}/segments", json={"text": "二番目"})
        assert second.status_code == 201, second.text
        unrelated = await client.post(
            f"/api/sources/{other_source['id']}/segments", json={"text": "他の片段"}
        )
        assert unrelated.status_code == 201, unrelated.text
        assert (await client.get(f"/api/sources/{source['id']}")).json()["segment_count"] == 2
        segment_list = (await client.get(f"/api/sources/{source['id']}/segments")).json()
        assert {item["id"] for item in segment_list} == {segment["id"], second.json()["id"]}
        assert segment_list == sorted(
            segment_list, key=lambda item: (item["created_at"], item["id"]), reverse=True
        )

        edited_source = await client.patch(f"/api/sources/{source['id']}", json={"note": "更新"})
        assert edited_source.status_code == 200, edited_source.text
        assert edited_source.json()["title"] == source["title"]
        assert edited_source.json()["description"] == source["description"]
        assert edited_source.json()["note"] == "更新"
        assert datetime.fromisoformat(edited_source.json()["updated_at"]) >= datetime.fromisoformat(
            source["updated_at"]
        )
        edited_segment = await client.patch(
            f"/api/segments/{segment['id']}",
            json={"text": " 新しい\n原文 ", "context_before": "前\nか\u3099"},
        )
        assert edited_segment.status_code == 200, edited_segment.text
        assert edited_segment.json()["text"] == " 新しい\n原文 "
        assert edited_segment.json()["context_before"] == "前\nが"
        assert edited_segment.json()["translation"] == "訳\nが"
        assert datetime.fromisoformat(
            edited_segment.json()["updated_at"]
        ) >= datetime.fromisoformat(segment["updated_at"])

    # A newly built app and engine must read the same records from the file.
    async with api_client(database) as client:
        source_reloaded = (await client.get(f"/api/sources/{source['id']}")).json()
        segment_reloaded = (await client.get(f"/api/segments/{segment['id']}")).json()
        assert source_reloaded["note"] == "更新"
        assert source_reloaded["segment_count"] == 2
        assert segment_reloaded["text"] == " 新しい\n原文 "
        assert segment_reloaded["context_before"] == "前\nが"


@pytest.mark.asyncio
async def test_reject_bad_input_and_read_only_fields(tmp_path: Path) -> None:
    async with api_client(tmp_path / "folio.db") as client:
        for payload in (
            {},
            {"title": " \n "},
            {"title": None},
            {"title": "x" * 201},
            {"title": "valid", "description": None},
            {"title": "valid", "unknown": "x"},
            {"title": "valid", "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV"},
            {"title": "valid", "deleted_at": None},
            {"title": "valid", "segment_count": 8},
        ):
            response = await client.post("/api/sources", json=payload)
            assert response.status_code == 422, (payload, response.text)

        source_response = await client.post("/api/sources", json={"title": "valid"})
        assert source_response.status_code == 201
        source = source_response.json()
        for payload in (
            {"title": None},
            {"description": None},
            {"note": None},
            {"source_id": source["id"]},
            {"created_at": source["created_at"]},
            {"deleted_at": None},
            {"segment_count": 1},
            {"unknown": "x"},
        ):
            response = await client.patch(f"/api/sources/{source['id']}", json=payload)
            assert response.status_code == 422, (payload, response.text)

        for payload in (
            {},
            {"text": " \n\t "},
            {"text": None},
            {"text": "x" * 100001},
            {"text": "valid", "note": None},
            {"text": "valid", "unknown": "x"},
            {"text": "valid", "source_id": source["id"]},
            {"text": "valid", "text_locked_at": None},
        ):
            response = await client.post(f"/api/sources/{source['id']}/segments", json=payload)
            assert response.status_code == 422, (payload, response.text)

        segment_response = await client.post(
            f"/api/sources/{source['id']}/segments", json={"text": "valid"}
        )
        assert segment_response.status_code == 201
        segment = segment_response.json()
        for payload in (
            {"text": " \t "},
            {"text": None},
            {"translation": None},
            {"source_id": source["id"]},
            {"id": segment["id"]},
            {"created_at": segment["created_at"]},
            {"text_locked_at": None},
            {"deleted_at": None},
            {"unknown": "x"},
        ):
            response = await client.patch(f"/api/segments/{segment['id']}", json=payload)
            assert response.status_code == 422, (payload, response.text)


@pytest.mark.asyncio
async def test_delete_impact_soft_deletion_and_isolation(tmp_path: Path) -> None:
    database = tmp_path / "folio.db"
    async with api_client(database) as client:
        source_a = (await client.post("/api/sources", json={"title": "A"})).json()
        source_b = (await client.post("/api/sources", json={"title": "B"})).json()

        async def add_segment(source_id: str, text: str) -> dict[str, Any]:
            response = await client.post(f"/api/sources/{source_id}/segments", json={"text": text})
            assert response.status_code == 201, response.text
            return response.json()

        a1 = await add_segment(source_a["id"], "A1")
        a2 = await add_segment(source_a["id"], "A2")
        b1 = await add_segment(source_b["id"], "B1")
        impact = await client.get(f"/api/sources/{source_a['id']}/delete-impact")
        assert impact.status_code == 200
        assert impact.json() == {
            "source_id": source_a["id"],
            "title": "A",
            "segment_count": 2,
            "thread_count": 0,
            "message_count": 0,
            "active_job_count": 0,
            "analysis_count": 0,
        }

        assert (await client.delete(f"/api/segments/{a1['id']}")).status_code == 204
        assert (await client.get(f"/api/segments/{a1['id']}")).status_code == 404
        assert (await client.get(f"/api/sources/{source_a['id']}")).json()["segment_count"] == 1
        assert (await client.get(f"/api/sources/{source_a['id']}/delete-impact")).json()[
            "segment_count"
        ] == 1
        assert (await client.delete(f"/api/sources/{source_a['id']}")).status_code == 204
        assert (await client.get(f"/api/sources/{source_a['id']}")).status_code == 404
        assert (await client.get(f"/api/sources/{source_a['id']}/delete-impact")).status_code == 404
        assert (await client.get(f"/api/sources/{source_a['id']}/segments")).status_code == 404
        assert (await client.get(f"/api/segments/{a2['id']}")).status_code == 404
        assert (
            await client.patch(f"/api/segments/{a2['id']}", json={"note": "x"})
        ).status_code == 404
        assert (await client.get(f"/api/segments/{b1['id']}")).status_code == 200
        assert (await client.get(f"/api/sources/{source_b['id']}")).json()["segment_count"] == 1
        assert [item["id"] for item in (await client.get("/api/sources")).json()] == [
            source_b["id"]
        ]
        assert (await client.delete(f"/api/segments/{a1['id']}")).status_code == 404
        assert (await client.delete(f"/api/sources/{source_a['id']}")).status_code == 404

        missing = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
        for path in (
            f"/api/sources/{missing}",
            f"/api/sources/{missing}/delete-impact",
            f"/api/sources/{missing}/segments",
            f"/api/segments/{missing}",
        ):
            assert (await client.get(path)).status_code == 404
        assert (
            await client.post(f"/api/sources/{missing}/segments", json={"text": "x"})
        ).status_code == 404
        assert (
            await client.patch(f"/api/sources/{missing}", json={"note": "x"})
        ).status_code == 404
        assert (
            await client.patch(f"/api/segments/{missing}", json={"note": "x"})
        ).status_code == 404
        assert (await client.delete(f"/api/sources/{missing}")).status_code == 404
        assert (await client.delete(f"/api/segments/{missing}")).status_code == 404

    with sqlite3.connect(database) as connection:
        rows = connection.execute(
            "SELECT id, deleted_at FROM sources WHERE id IN (?, ?)",
            (source_a["id"], source_b["id"]),
        ).fetchall()
        assert len(rows) == 2
        assert dict(rows)[source_a["id"]] is not None
        assert dict(rows)[source_b["id"]] is None
        segments = dict(connection.execute("SELECT id, deleted_at FROM segments").fetchall())
        assert segments[a1["id"]] is not None
        assert segments[a2["id"]] is not None
        assert segments[b1["id"]] is None


@pytest.mark.asyncio
async def test_locked_text_conflict_same_normalized_text_and_metadata_edit(tmp_path: Path) -> None:
    database = tmp_path / "folio.db"
    async with api_client(database) as client:
        source = (await client.post("/api/sources", json={"title": "Lock"})).json()
        segment = (
            await client.post(f"/api/sources/{source['id']}/segments", json={"text": "が\nく"})
        ).json()

        # The future AI task will set this in its own transaction. There is no manual lock API.
        engine = create_engine(database)
        try:
            session_factory = async_sessionmaker(engine)
            async with session_factory() as session:
                row = await session.scalar(select(Segment).where(Segment.id == segment["id"]))
                assert row is not None
                row.text_locked_at = datetime.now(UTC)
                await session.commit()
        finally:
            await engine.dispose()

        changed = await client.patch(f"/api/segments/{segment['id']}", json={"text": "別文"})
        assert changed.status_code == 409, changed.text
        same = await client.patch(f"/api/segments/{segment['id']}", json={"text": "か\u3099\nく"})
        assert same.status_code == 200, same.text
        assert same.json()["text"] == "が\nく"
        metadata = await client.patch(
            f"/api/segments/{segment['id']}", json={"note": "管理用", "translation": "訳"}
        )
        assert metadata.status_code == 200, metadata.text
        assert metadata.json()["text"] == "が\nく"
        assert metadata.json()["text_locked_at"] is not None
        assert_utc_timestamp(metadata.json()["text_locked_at"])
        assert (await client.get(f"/api/segments/{segment['id']}")).json()["note"] == "管理用"


def test_initial_migration_creates_source_and_segment_tables(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "migration.db"
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        tables = {
            name
            for (name,) in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        assert {"alembic_version", "sources", "segments"} <= tables
        source_columns = {row[1] for row in connection.execute("PRAGMA table_info(sources)")}
        segment_columns = {row[1] for row in connection.execute("PRAGMA table_info(segments)")}
        assert {
            "id",
            "title",
            "description",
            "note",
            "created_at",
            "updated_at",
            "deleted_at",
        } <= source_columns
        assert {
            "id",
            "source_id",
            "text",
            "translation",
            "context_before",
            "context_after",
            "transcription",
            "note",
            "source_ref",
            "created_at",
            "updated_at",
            "text_locked_at",
            "deleted_at",
        } <= segment_columns
