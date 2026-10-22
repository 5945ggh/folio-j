"""Material removal preserves learning content and anchors requests to old identities."""

import asyncio
import hashlib
import sqlite3
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy.exc import IntegrityError
from test_database_contract import (
    JOB_ID,
    RUN_ID,
    SOURCE_ID,
    insert_discussion,
    insert_job,
    insert_run,
    rebuild_database,
)
from test_materials import compiled
from test_source_segment import api_client

from app.ids import new_ulid

ASSET_TABLES = (
    "reading_positions",
    "chapter_reading_positions",
    "material_usage",
    "material_covers",
    "material_custom_covers",
    "material_readings_current",
    "material_readings_generations",
)


def seed_assets(database: Path, material_id: str) -> None:
    """Give each imported book its own complete mutable and immutable assets."""
    with sqlite3.connect(database) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        for table, columns, values in (
            ("reading_positions", "revision,payload,updated_at", "7,'{}','2020-01-01'"),
            (
                "chapter_reading_positions",
                "chapter_id,revision,payload,updated_at",
                "'chapter',7,'{}','2020-01-01'",
            ),
            ("material_usage", "status,revision,updated_at", "'completed',3,'2020-01-01'"),
            (
                "material_covers",
                "media_type,data,rule_version,diagnostic_reason",
                "'image/png',X'1234',2,'retained'",
            ),
            ("material_custom_covers", "media_type,data", "'image/png',X'5678'"),
        ):
            connection.execute(
                f"INSERT OR REPLACE INTO {table} (material_id,{columns}) VALUES (?,{values})",
                (material_id,),
            )
        connection.execute(
            "UPDATE materials SET warnings=? WHERE id=?", ('["historical warning"]', material_id)
        )
        connection.execute(
            "INSERT INTO material_readings_generations "
            "(id,material_id,version_id,asset_sha256,configuration,token_count,payload,created_at) "
            "SELECT ?,material_id,version_id,?,configuration,token_count,payload,created_at "
            "FROM material_readings_generations WHERE material_id=? LIMIT 1",
            (new_ulid(), hashlib.sha256(b"historical generation").hexdigest(), material_id),
        )


def asset_snapshot(database: Path, material_id: str) -> dict[str, list[tuple[Any, ...]]]:
    with sqlite3.connect(database) as connection:
        return {
            table: connection.execute(
                f"SELECT * FROM {table} WHERE material_id=? ORDER BY rowid", (material_id,)
            ).fetchall()
            for table in ASSET_TABLES
        }


def material_snapshot(database: Path, material_id: str) -> tuple[Any, ...]:
    with sqlite3.connect(database) as connection:
        row = connection.execute("SELECT * FROM materials WHERE id=?", (material_id,)).fetchone()
        assert row is not None
        return row


@pytest.mark.asyncio
async def test_delete_preserves_learning_content_gates_every_entry_and_reimports(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    database = tmp_path / "delete.db"
    await asyncio.to_thread(rebuild_database, database, monkeypatch)
    async with api_client(database) as client:
        with sqlite3.connect(database) as connection:
            insert_discussion(connection)
            insert_job(connection, JOB_ID, "waiting_review")
            insert_run(connection, RUN_ID, JOB_ID)
            connection.execute(
                "INSERT INTO chat_messages (id,thread_id,job_id,ordinal,role,status,content,"
                "created_at,updated_at) SELECT 'message',thread_id,id,1,'assistant','succeeded',"
                "'讨论内容',created_at,created_at FROM chat_jobs"
            )
            connection.execute(
                "INSERT INTO analyses (id,segment_id,operation_key,title,excerpt,"
                "current_revision_id,created_at,"
                "updated_at) SELECT 'analysis',id,'analysis','講解','抜粋','revision',"
                "created_at,updated_at "
                "FROM segments"
            )
            connection.execute(
                "INSERT INTO analysis_revisions (id,analysis_id,operation_key,operation_payload,"
                "origin,source_md,normalizer_version,warnings,created_at) "
                "SELECT 'revision',id,'revision','{}','manual','講解',1,'[]',created_at "
                "FROM analyses"
            )
            connection.execute(
                "INSERT INTO analysis_sections (id,revision_id,uid,handle,kind,display_no,title,"
                "start_line,end_line,raw,ordinal) VALUES "
                "('section','revision','section-uid','s1','section','1','講解',0,1,'講解',1)"
            )
            connection.commit()
            retained = {
                table: connection.execute(f"SELECT * FROM {table}").fetchall()
                for table in (
                    "sources",
                    "segments",
                    "analyses",
                    "analysis_revisions",
                    "analysis_sections",
                    "chat_threads",
                    "chat_messages",
                    "chat_jobs",
                    "runs",
                )
            }
        upload_url = f"/api/sources/{SOURCE_ID}/materials"
        headers = {"content-type": "application/epub+zip"}
        first = (await client.post(upload_url, content=b"book", headers=headers)).json()["material"]
        other = (await client.post(upload_url, content=b"other", headers=headers)).json()[
            "material"
        ]
        url = f"/api/materials/{first['id']}"
        version = first["version_id"]
        # Warm derived state before removal, then verify caches cannot bypass its gate.
        assert (
            await client.get(url + "/statistics", params={"version_id": version})
        ).status_code == 200
        assert (await client.get(url + "/cover")).status_code == 404
        anchor = {
            "expected_revision": 0,
            "version_id": version,
            "chapter_id": "c1",
            "part_index": 0,
            "resource_id": "r1",
            "kind": "text",
            "offset": 1,
        }
        assert (await client.put(url + "/reading-position", json=anchor)).status_code == 200
        seed_assets(database, first["id"])
        seed_assets(database, other["id"])
        other_assets = asset_snapshot(database, other["id"])
        assert all(other_assets.values())
        other_material = material_snapshot(database, other["id"])
        for _ in range(2):
            deleted = await client.delete(url)
            assert deleted.status_code == 204 and deleted.content == b""
        for suffix in (
            "",
            "/details",
            "/chapters/c1",
            "/usage",
            "/cover",
            "/statistics",
            "/search",
            "/illustrations",
            "/illustrations/0/content",
            "/readings",
        ):
            result = await client.get(
                url + suffix, params={"version_id": version, "chapter_id": "c1", "q": "日本"}
            )
            assert result.status_code == 404, (suffix, result.text)
        for method, suffix, payload in (
            ("PUT", "/reading-position", anchor),
            ("PUT", "/usage", {"status": "completed", "expected_revision": 0}),
            ("POST", "/opened", {"action_id": "late", "expected_revision": 0}),
            ("PATCH", "/metadata", {"title": "late", "expected_revision": 0}),
            ("POST", "/readings/prepare", {"version_id": version, "force": True}),
        ):
            result = await client.request(method, url + suffix, json=payload)
            assert result.status_code == 404, (suffix, result.text)
        assert [m["id"] for m in (await client.get(upload_url)).json()] == [other["id"]]
        assert (await client.get("/api/materials")).json()["total"] == 1
        assert (await client.get("/api/catalog/sources")).json()["items"][0]["material_count"] == 1
        assert (await client.get(f"/api/sources/{SOURCE_ID}/delete-impact")).json()[
            "material_count"
        ] == 1
        with sqlite3.connect(database) as connection:
            for table, rows in retained.items():
                assert connection.execute(f"SELECT * FROM {table}").fetchall() == rows
            assert connection.execute(
                "SELECT original_bytes,compiled_bundle,warnings FROM materials WHERE id=?",
                (first["id"],),
            ).fetchone() == (b"", b"", "[]")
            assert connection.execute(
                "SELECT id,source_id,title,source_sha256,version_id,created_at FROM materials "
                "WHERE id=?",
                (first["id"],),
            ).fetchone() == (
                first["id"],
                first["source_id"],
                first["title"],
                first["source_sha256"],
                first["version_id"],
                first["created_at"].replace("T", " ").removesuffix("Z"),
            )
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert not any(asset_snapshot(database, first["id"]).values())
        assert asset_snapshot(database, other["id"]) == other_assets
        assert material_snapshot(database, other["id"]) == other_material
        copies = await asyncio.gather(
            *[client.post(upload_url, content=b"book", headers=headers) for _ in range(2)]
        )
        fresh = copies[0].json()["material"]
        assert fresh["id"] == copies[1].json()["material"]["id"] != first["id"]
        assert fresh["version_id"] != version and fresh["reading_position"] is None
        assert (await client.put(url + "/reading-position", json=anchor)).status_code == 404
        assert (await client.get(f"/api/materials/{fresh['id']}/usage")).json()["revision"] == 0
        assert (await client.delete("/api/materials/missing")).status_code == 404
        assert (await client.delete(f"/api/sources/{SOURCE_ID}")).status_code == 204
        assert (await client.delete(url)).status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["prepare", "import"])
async def test_late_work_cannot_publish_into_reimported_material(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    from app.nlp.contracts import TextResource
    from app.nlp.tokenization import GeneratedReadings
    from app.services import readings

    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    database = tmp_path / "late.db"
    async with api_client(database) as client:
        source = (await client.post("/api/sources", json={"title": "本"})).json()["id"]
        upload_url = f"/api/sources/{source}/materials"
        headers = {"content-type": "application/epub+zip"}
        first = (await client.post(upload_url, content=b"book", headers=headers)).json()["material"]
        started, release = asyncio.Event(), asyncio.Event()
        build = readings.build
        from collections.abc import Sequence

        calls = 0

        async def delayed(resources: Sequence[TextResource]) -> GeneratedReadings:
            nonlocal calls
            calls += 1
            if calls == 1:
                started.set()
                await release.wait()
            return await build(resources)

        monkeypatch.setattr(readings, "build", delayed)
        raw = b"raced" if operation == "import" else b"book"
        pending = asyncio.create_task(
            client.post(upload_url, content=raw, headers=headers)
            if operation == "import"
            else client.post(
                f"/api/materials/{first['id']}/readings/prepare",
                json={"version_id": first["version_id"], "force": True},
            )
        )
        await asyncio.wait_for(started.wait(), 5)
        try:
            old = (
                (await client.post(upload_url, content=raw, headers=headers)).json()["material"]
                if operation == "import"
                else first
            )
            assert (await client.delete(f"/api/materials/{old['id']}")).status_code == 204
            fresh = (await client.post(upload_url, content=raw, headers=headers)).json()["material"]
            assert fresh["id"] != old["id"]
            with sqlite3.connect(database) as connection:
                generations = connection.execute(
                    "SELECT * FROM material_readings_generations"
                ).fetchall()
                pointers = connection.execute("SELECT * FROM material_readings_current").fetchall()
        finally:
            release.set()
        assert (await pending).status_code == 404
        with sqlite3.connect(database) as connection:
            assert (
                connection.execute("SELECT * FROM material_readings_generations").fetchall()
                == generations
            )
            assert (
                connection.execute("SELECT * FROM material_readings_current").fetchall() == pointers
            )


@pytest.mark.asyncio
async def test_late_cover_extraction_cannot_cache_removed_material(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import threading

    from test_covers import cover_book

    from app.services import covers

    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    database = tmp_path / "cover.db"
    async with api_client(database) as client:
        source = (await client.post("/api/sources", json={"title": "本"})).json()["id"]
        upload_url = f"/api/sources/{source}/materials"
        headers = {"content-type": "application/epub+zip"}
        raw = cover_book()
        old = (await client.post(upload_url, content=raw, headers=headers)).json()["material"]
        started, release = threading.Event(), threading.Event()
        inspect = covers.inspect_cover

        def delayed(raw: bytes) -> covers.CoverExtraction:
            started.set()
            assert release.wait(5)
            return inspect(raw)

        monkeypatch.setattr(covers, "inspect_cover", delayed)
        pending = asyncio.create_task(client.get(f"/api/materials/{old['id']}/cover"))
        assert await asyncio.to_thread(started.wait, 5)
        try:
            assert (await client.delete(f"/api/materials/{old['id']}")).status_code == 204
            fresh = (await client.post(upload_url, content=raw, headers=headers)).json()["material"]
            assert fresh["id"] != old["id"]
        finally:
            release.set()
        assert (await pending).status_code == 404
        with sqlite3.connect(database) as connection:
            assert connection.execute("SELECT count(*) FROM material_covers").fetchone() == (0,)


@pytest.mark.asyncio
@pytest.mark.parametrize("already_deleted", [False, True])
async def test_asset_cleanup_and_tombstone_commit_or_roll_back_together(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, already_deleted: bool
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    database = tmp_path / "atomic.db"
    async with api_client(database) as client:
        source = (await client.post("/api/sources", json={"title": "本"})).json()["id"]
        response = await client.post(
            f"/api/sources/{source}/materials",
            content=b"book",
            headers={"content-type": "application/epub+zip"},
        )
        material_id = response.json()["material"]["id"]
        seed_assets(database, material_id)
        with sqlite3.connect(database) as connection:
            if already_deleted:
                # A tombstone created by the previous release still has assets.
                connection.execute(
                    "UPDATE materials SET deleted_at='2020-01-02' WHERE id=?", (material_id,)
                )
            connection.execute(
                "CREATE TRIGGER reject_cleanup BEFORE DELETE ON material_readings_generations "
                "BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END"
            )
        material_before = material_snapshot(database, material_id)
        assets_before = asset_snapshot(database, material_id)
        assert all(assets_before.values())
        url = f"/api/materials/{material_id}"
        with pytest.raises(IntegrityError, match="injected cleanup failure"):
            await client.delete(url)
        assert material_snapshot(database, material_id) == material_before
        assert asset_snapshot(database, material_id) == assets_before
        with sqlite3.connect(database) as connection:
            connection.execute("DROP TRIGGER reject_cleanup")
        assert (await client.delete(url)).status_code == 204
        assert not any(asset_snapshot(database, material_id).values())
        with sqlite3.connect(database) as connection:
            row = connection.execute(
                "SELECT original_bytes,compiled_bundle,warnings,deleted_at FROM materials "
                "WHERE id=?",
                (material_id,),
            ).fetchone()
            assert row is not None and row[:3] == (b"", b"", "[]") and row[3] is not None
            if already_deleted:
                assert row[3] == "2020-01-02"
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert (await client.delete(url)).status_code == 204


@pytest.mark.asyncio
async def test_removed_material_pages_are_available_for_explicit_reimport(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    database = tmp_path / "space.db"
    raw = b"managed original bytes" * 100_000
    async with api_client(database) as client:
        source = (await client.post("/api/sources", json={"title": "本"})).json()["id"]
        upload_url = f"/api/sources/{source}/materials"
        headers = {"content-type": "application/epub+zip"}
        old = (await client.post(upload_url, content=raw, headers=headers)).json()["material"]
        seed_assets(database, old["id"])
        with sqlite3.connect(database) as connection:
            assert connection.execute("PRAGMA auto_vacuum").fetchone() == (0,)
            connection.execute(
                "UPDATE material_readings_generations SET payload=? WHERE material_id=?",
                (b"derived data" * 25_000, old["id"]),
            )
            connection.commit()
            free_before = connection.execute("PRAGMA freelist_count").fetchone()
            assert free_before is not None
        assert (await client.delete(f"/api/materials/{old['id']}")).status_code == 204
        with sqlite3.connect(database) as connection:
            free_removed = connection.execute("PRAGMA freelist_count").fetchone()
            assert free_removed is not None and free_removed[0] > free_before[0]
            assert connection.execute(
                "SELECT length(original_bytes),length(compiled_bundle) FROM materials WHERE id=?",
                (old["id"],),
            ).fetchone() == (0, 0)
        assert not any(asset_snapshot(database, old["id"]).values())
        fresh = (await client.post(upload_url, content=raw, headers=headers)).json()["material"]
        assert fresh["id"] != old["id"] and fresh["version_id"] != old["version_id"]
        with sqlite3.connect(database) as connection:
            free_reimported = connection.execute("PRAGMA freelist_count").fetchone()
            assert free_reimported is not None and free_reimported[0] < free_removed[0]
            assert connection.execute(
                "SELECT original_bytes FROM materials WHERE id=?", (fresh["id"],)
            ).fetchone() == (raw,)
            assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
