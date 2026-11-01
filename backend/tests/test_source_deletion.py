"""Deleting learning content interrupts review work and retains its call history."""

import asyncio
import hashlib
import sqlite3
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker
from support_api import api_client
from support_epub import compiled
from test_database_contract import (
    JOB_ID,
    RUN_ID,
    SEGMENT_ID,
    SOURCE_ID,
    insert_discussion,
    insert_job,
    insert_run,
    rebuild_database,
)
from test_material_deletion import ASSET_TABLES, asset_snapshot, material_snapshot, seed_assets

from app.db import create_engine
from app.services.sources import begin_write, soft_delete_discussions


def table_snapshot(database: Path, tables: Sequence[str]) -> dict[str, list[tuple[Any, ...]]]:
    with sqlite3.connect(database) as connection:
        return {
            table: connection.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()
            for table in tables
        }


def seed_learning_history(database: Path) -> None:
    with sqlite3.connect(database) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        insert_discussion(connection)
        insert_job(connection, JOB_ID, "waiting_review")
        insert_run(connection, RUN_ID, JOB_ID)
        connection.execute(
            "INSERT INTO chat_messages (id,thread_id,job_id,ordinal,role,status,content,"
            "created_at,updated_at) SELECT 'message',thread_id,id,1,'assistant','succeeded',"
            "'讨论内容',created_at,created_at FROM chat_jobs"
        )


@pytest.mark.asyncio
async def test_segment_deletion_interrupts_review_and_marks_all_runs_deleted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "deletion.db"
    await asyncio.to_thread(rebuild_database, database, monkeypatch)
    second_run_id = "01ARZ3NDEKTSV4RRFFQ69G5FB0"
    with sqlite3.connect(database) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        insert_discussion(connection)
        insert_job(connection, JOB_ID, "waiting_review")
        insert_run(connection, RUN_ID, JOB_ID)
        insert_run(connection, second_run_id, JOB_ID)
        connection.execute("UPDATE runs SET status='running' WHERE id=?", (second_run_id,))
    engine = create_engine(database)
    try:
        factory = async_sessionmaker(engine, expire_on_commit=False)
        async with factory() as session:
            await begin_write(session)
            interrupted = await soft_delete_discussions(session, [SEGMENT_ID], datetime.now(UTC))
            await session.commit()
        assert interrupted == [JOB_ID]
        with sqlite3.connect(database) as connection:
            job = connection.execute(
                "SELECT status,deleted_at FROM chat_jobs WHERE id=?", (JOB_ID,)
            ).fetchone()
            assert job is not None and job[0] == "interrupted" and job[1] is not None
            runs = connection.execute(
                "SELECT status,deleted_at FROM runs WHERE job_id=? ORDER BY id", (JOB_ID,)
            ).fetchall()
            assert runs[0][0] == "succeeded" and runs[0][1] is not None
            assert runs[1][0] == "interrupted" and runs[1][1] is not None
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_source_delete_cleans_all_books_and_retains_learning_and_other_sources(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    database = tmp_path / "source-delete.db"
    await asyncio.to_thread(rebuild_database, database, monkeypatch)
    async with api_client(database) as client:
        seed_learning_history(database)
        other_source = (await client.post("/api/sources", json={"title": "保留来源"})).json()["id"]
        other_segment = await client.post(
            f"/api/sources/{other_source}/segments", json={"text": "保留原文"}
        )
        assert other_segment.status_code == 201
        headers = {"content-type": "application/epub+zip"}
        books: list[dict[str, Any]] = []
        for source, raw in (
            (SOURCE_ID, b"first"),
            (SOURCE_ID, b"second"),
            (SOURCE_ID, b"legacy"),
            (other_source, b"first"),
        ):
            response = await client.post(
                f"/api/sources/{source}/materials", content=raw, headers=headers
            )
            assert response.status_code == 200, response.text
            material = response.json()["material"]
            books.append(material)
            seed_assets(database, material["id"])
            assert all(asset_snapshot(database, material["id"]).values())
        first, second, historical, other = books
        anchor = {
            "version_id": first["version_id"],
            "chapter_id": "c1",
            "part_index": 0,
            "resource_id": "r1",
            "kind": "text",
            "offset": 1,
        }
        bookmark = await client.post(
            f"/api/materials/{first['id']}/bookmarks",
            json={"request_id": str(uuid4()), "position": anchor},
        )
        assert bookmark.status_code == 200, bookmark.text
        segment = await client.post(
            f"/api/sources/{SOURCE_ID}/segments",
            json={
                "request_id": str(uuid4()),
                "source_ref": "原書の出典補足",
                "material_provenance": {
                    "contract_version": "1",
                    "material_id": first["id"],
                    "version_id": first["version_id"],
                    "ranges": [
                        {
                            "resource_id": "r1",
                            "spine_index": 0,
                            "start": 0,
                            "end": 2,
                            "exact": "日本",
                            "text_sha256": hashlib.sha256("日本語".encode()).hexdigest(),
                        }
                    ],
                },
            },
        )
        assert segment.status_code == 201, segment.text
        saved_segment = segment.json()
        analysis = await client.post(
            f"/api/segments/{saved_segment['id']}/analyses",
            json={
                "request_id": str(uuid4()),
                "expected_text_sha256": saved_segment["text_sha256"],
                "source_md": "## 文法\n\n保存した説明。\n",
            },
        )
        assert analysis.status_code == 200, analysis.text
        with sqlite3.connect(database) as connection:
            # A previous release soft-deleted this book without releasing its managed assets.
            connection.execute(
                "UPDATE materials SET deleted_at='2020-01-02' WHERE id=?", (historical["id"],)
            )
        immutable_tables = (
            "analysis_revisions",
            "analysis_sections",
            "material_bookmarks",
            "segment_material_provenance",
        )
        retained = table_snapshot(database, immutable_tables)
        assert all(retained.values())
        other_before = material_snapshot(database, other["id"])
        other_assets = asset_snapshot(database, other["id"])
        with sqlite3.connect(database) as connection:
            identities = connection.execute(
                "SELECT id,source_id,title,source_sha256,version_id,created_at FROM materials "
                "WHERE source_id=? ORDER BY id",
                (SOURCE_ID,),
            ).fetchall()
            other_source_before = connection.execute(
                "SELECT * FROM sources WHERE id=?", (other_source,)
            ).fetchone()
            other_segment_before = connection.execute(
                "SELECT * FROM segments WHERE id=?", (other_segment.json()["id"],)
            ).fetchone()
        impact = await client.get(f"/api/sources/{SOURCE_ID}/delete-impact")
        assert impact.status_code == 200 and impact.json()["material_count"] == 2
        assert (await client.delete(f"/api/sources/{SOURCE_ID}")).status_code == 204
        for book in (first, second, historical):
            assert not any(asset_snapshot(database, book["id"]).values())
            url = f"/api/materials/{book['id']}"
            for suffix in ("", "/details", "/chapters/c1", "/readings", "/bookmarks"):
                result = await client.get(
                    url + suffix,
                    params={"version_id": book["version_id"], "chapter_id": "c1"},
                )
                assert result.status_code == 404, (suffix, result.text)
            for method, suffix, payload in (
                ("PUT", "/reading-position", {**anchor, "expected_revision": 7}),
                ("PUT", "/usage", {"status": "completed", "expected_revision": 3}),
                ("PATCH", "/metadata", {"title": "late", "expected_revision": 0}),
                ("POST", "/readings/prepare", {"version_id": book["version_id"], "force": True}),
            ):
                result = await client.request(method, url + suffix, json=payload)
                assert result.status_code == 404, (suffix, result.text)
        assert (await client.get(f"/api/segments/{saved_segment['id']}")).status_code == 404
        assert (await client.get(f"/api/analyses/{analysis.json()['id']}")).status_code == 404
        assert (await client.get(f"/api/sources/{SOURCE_ID}/materials")).status_code == 404
        assert [item["id"] for item in (await client.get("/api/sources")).json()] == [other_source]
        assert (await client.get("/api/materials")).json()["total"] == 1
        assert (await client.get(f"/api/materials/{other['id']}/chapters/c1")).status_code == 200
        assert table_snapshot(database, immutable_tables) == retained
        assert material_snapshot(database, other["id"]) == other_before
        assert asset_snapshot(database, other["id"]) == other_assets
        with sqlite3.connect(database) as connection:
            assert (
                connection.execute(
                    "SELECT id,source_id,title,source_sha256,version_id,created_at FROM materials "
                    "WHERE source_id=? ORDER BY id",
                    (SOURCE_ID,),
                ).fetchall()
                == identities
            )
            cleared = connection.execute(
                "SELECT original_bytes,compiled_bundle,warnings,deleted_at FROM materials "
                "WHERE source_id=?",
                (SOURCE_ID,),
            ).fetchall()
            assert len(cleared) == 3
            assert all(row[:3] == (b"", b"", "[]") and row[3] is not None for row in cleared)
            assert connection.execute(
                "SELECT deleted_at FROM materials WHERE id=?", (historical["id"],)
            ).fetchone() == ("2020-01-02",)
            for table, count in (
                ("sources", 1),
                ("segments", 2),
                ("analyses", 1),
                ("chat_threads", 1),
                ("chat_messages", 1),
                ("chat_jobs", 1),
                ("runs", 1),
            ):
                rows = connection.execute(
                    f"SELECT deleted_at FROM {table} "
                    + (
                        "WHERE id=?"
                        if table == "sources"
                        else "WHERE source_id=?"
                        if table == "segments"
                        else ""
                    ),
                    (SOURCE_ID,) if table in {"sources", "segments"} else (),
                ).fetchall()
                assert len(rows) == count and all(row[0] is not None for row in rows), table
            assert connection.execute(
                "SELECT status,error_code FROM chat_jobs WHERE id=?", (JOB_ID,)
            ).fetchone() == ("interrupted", "content_deleted")
            assert connection.execute(
                "SELECT status FROM runs WHERE id=?", (RUN_ID,)
            ).fetchone() == ("succeeded",)
            assert connection.execute("SELECT content FROM chat_messages").fetchone() == (
                "讨论内容",
            )
            assert connection.execute(
                "SELECT text,source_ref FROM segments WHERE id=?", (saved_segment["id"],)
            ).fetchone() == ("日本", "原書の出典補足")
            assert (
                connection.execute("SELECT * FROM sources WHERE id=?", (other_source,)).fetchone()
                == other_source_before
            )
            assert (
                connection.execute(
                    "SELECT * FROM segments WHERE id=?", (other_segment.json()["id"],)
                ).fetchone()
                == other_segment_before
            )
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["asset_cleanup", "source_tombstone"])
async def test_source_cleanup_and_learning_deletion_roll_back_together(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    database = tmp_path / "atomic-source.db"
    await asyncio.to_thread(rebuild_database, database, monkeypatch)
    async with api_client(database) as client:
        seed_learning_history(database)
        segment = (await client.get(f"/api/segments/{SEGMENT_ID}")).json()
        analysis = await client.post(
            f"/api/segments/{SEGMENT_ID}/analyses",
            json={
                "request_id": str(uuid4()),
                "expected_text_sha256": segment["text_sha256"],
                "source_md": "## 文法\n\n説明も削除と同時に確定する。\n",
            },
        )
        assert analysis.status_code == 200, analysis.text
        materials: list[str] = []
        for raw in (b"first", b"second"):
            response = await client.post(
                f"/api/sources/{SOURCE_ID}/materials",
                content=raw,
                headers={"content-type": "application/epub+zip"},
            )
            assert response.status_code == 200, response.text
            material_id = response.json()["material"]["id"]
            materials.append(material_id)
            seed_assets(database, material_id)
        with sqlite3.connect(database) as connection:
            connection.execute(
                "UPDATE materials SET deleted_at='2020-01-02' WHERE id=?", (materials[1],)
            )
            event = (
                "BEFORE DELETE ON material_readings_generations"
                if failure == "asset_cleanup"
                else "BEFORE UPDATE OF deleted_at ON sources"
            )
            connection.execute(
                f"CREATE TRIGGER reject_source_delete {event} "
                "BEGIN SELECT RAISE(ABORT, 'injected source deletion failure'); END"
            )
        tables = (
            "sources",
            "segments",
            "materials",
            "chat_threads",
            "chat_messages",
            "chat_jobs",
            "runs",
            "analyses",
            "analysis_revisions",
            "analysis_sections",
            *ASSET_TABLES,
        )
        before = table_snapshot(database, tables)
        for material_id in materials:
            assert all(asset_snapshot(database, material_id).values())
        with pytest.raises(IntegrityError, match="injected source deletion failure"):
            await client.delete(f"/api/sources/{SOURCE_ID}")
        assert table_snapshot(database, tables) == before
        with sqlite3.connect(database) as connection:
            connection.execute("DROP TRIGGER reject_source_delete")
        assert (await client.delete(f"/api/sources/{SOURCE_ID}")).status_code == 204
        for material_id in materials:
            assert not any(asset_snapshot(database, material_id).values())
        with sqlite3.connect(database) as connection:
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
