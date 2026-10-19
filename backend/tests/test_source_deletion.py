"""Deleting learning content interrupts review work and retains its call history."""

import asyncio
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker
from test_database_contract import (
    JOB_ID,
    RUN_ID,
    SEGMENT_ID,
    insert_discussion,
    insert_job,
    insert_run,
    rebuild_database,
)

from app.db import create_engine
from app.services.sources import begin_write, soft_delete_discussions


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
