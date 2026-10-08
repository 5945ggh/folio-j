"""Analysis execution migration preserves existing work and updates job constraints."""

import asyncio
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import pytest
from alembic.config import Config
from sqlalchemy.ext.asyncio import async_sessionmaker

from alembic import command
from app.db import create_engine
from app.services.sources import begin_write, soft_delete_discussions

SOURCE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
SEGMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW"
THREAD_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX"
JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY"
RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ"
STAMP = "2026-09-26 00:00:00"


def _config(database: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    return config


def _insert_job(connection: sqlite3.Connection, job_id: str, request_id: str, status: str) -> None:
    connection.execute(
        "INSERT INTO chat_jobs "
        "(id,kind,thread_id,request_id,request_payload,status,input_snapshot,"
        "model_snapshot,permission_mode,created_at,version) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (job_id, "chat", THREAD_ID, request_id, "{}", status, "{}", "{}", "review", STAMP, 1),
    )


def _insert_run(connection: sqlite3.Connection, run_id: str, job_id: str) -> None:
    connection.execute(
        "INSERT INTO runs "
        "(id,purpose,job_id,provider_id,provider_name,provider_revision,provider_model_id,"
        "model_revision,model_id,protocol,stream,status,output_text,prompt_version,"
        "prompt_text,base_url,created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            run_id,
            "chat",
            job_id,
            SOURCE_ID,
            "存量 Provider",
            1,
            SEGMENT_ID,
            1,
            "model",
            "responses",
            0,
            "succeeded",
            "旧输出",
            "v1",
            "旧提示",
            "http://localhost:9999/v1",
            STAMP,
        ),
    )


def test_upgrade_from_existing_chat_allows_multiple_runs_per_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "existing.db"
    config = _config(database, monkeypatch)
    command.upgrade(config, "0004_chat_jobs")
    with sqlite3.connect(database) as connection:
        connection.execute(
            "INSERT INTO sources (id,title,description,note,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?)",
            (SOURCE_ID, "旧资料", "", "", STAMP, STAMP),
        )
        connection.execute(
            "INSERT INTO segments (id,source_id,text,translation,context_before,context_after,"
            "transcription,note,source_ref,created_at,updated_at,revision) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (SEGMENT_ID, SOURCE_ID, "旧原文", "", "", "", "", "", "", STAMP, STAMP, 1),
        )
        connection.execute(
            "INSERT INTO chat_threads "
            "(id,segment_id,create_request_id,create_request_payload,permission_mode,"
            "revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (THREAD_ID, SEGMENT_ID, "old-thread", "{}", "review", 1, STAMP, STAMP),
        )
        _insert_job(connection, JOB_ID, "old-job", "succeeded")
        _insert_run(connection, RUN_ID, JOB_ID)
    command.upgrade(config, "head")
    with sqlite3.connect(database) as connection:
        source = connection.execute("SELECT title FROM sources WHERE id=?", (SOURCE_ID,)).fetchone()
        segment = connection.execute(
            "SELECT text FROM segments WHERE id=?", (SEGMENT_ID,)
        ).fetchone()
        job = connection.execute(
            "SELECT status, execution_state FROM chat_jobs WHERE id=?", (JOB_ID,)
        ).fetchone()
        run = connection.execute("SELECT output_text FROM runs WHERE id=?", (RUN_ID,)).fetchone()
        assert source == ("旧资料",)
        assert segment == ("旧原文",)
        assert job == ("succeeded", "{}")
        assert run == ("旧输出",)
        _insert_run(connection, "01ARZ3NDEKTSV4RRFFQ69G5FB0", JOB_ID)
        run_count = connection.execute(
            "SELECT count(*) FROM runs WHERE job_id=?", (JOB_ID,)
        ).fetchone()
        assert run_count == (2,)
        _insert_job(connection, "01ARZ3NDEKTSV4RRFFQ69G5FB1", "review-job", "waiting_review")
        with pytest.raises(sqlite3.IntegrityError):
            _insert_job(connection, "01ARZ3NDEKTSV4RRFFQ69G5FB2", "queued-job", "queued")
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


@pytest.mark.asyncio
async def test_segment_deletion_interrupts_review_and_marks_all_runs_deleted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "deletion.db"
    await asyncio.to_thread(command.upgrade, _config(database, monkeypatch), "head")
    second_run_id = "01ARZ3NDEKTSV4RRFFQ69G5FB0"
    with sqlite3.connect(database) as connection:
        connection.execute(
            "INSERT INTO sources (id,title,description,note,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?)",
            (SOURCE_ID, "资料", "", "", STAMP, STAMP),
        )
        connection.execute(
            "INSERT INTO segments (id,source_id,text,translation,context_before,context_after,"
            "transcription,note,source_ref,created_at,updated_at,revision) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (SEGMENT_ID, SOURCE_ID, "原文", "", "", "", "", "", "", STAMP, STAMP, 1),
        )
        connection.execute(
            "INSERT INTO chat_threads "
            "(id,segment_id,create_request_id,create_request_payload,permission_mode,"
            "revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (THREAD_ID, SEGMENT_ID, "thread", "{}", "review", 1, STAMP, STAMP),
        )
        _insert_job(connection, JOB_ID, "review", "waiting_review")
        _insert_run(connection, RUN_ID, JOB_ID)
        _insert_run(connection, second_run_id, JOB_ID)
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
