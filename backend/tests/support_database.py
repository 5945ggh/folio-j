import sqlite3
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import pytest
from alembic.config import Config

from alembic import command

SOURCE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV"


SEGMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW"


THREAD_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX"


JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY"


RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ"


STAMP = "2026-09-26 00:00:00"


def rebuild_database(database: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(database))
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    command.upgrade(config, "head")


def insert_discussion(connection: sqlite3.Connection) -> None:
    connection.execute(
        "INSERT INTO sources (id,title,description,note,created_at,updated_at) "
        "VALUES (?,?,?,?,?,?)",
        (SOURCE_ID, "资料", "", "", STAMP, STAMP),
    )
    connection.execute(
        "INSERT INTO segments (id,source_id,text,translation,context_before,context_after,"
        "transcription,note,source_ref,created_at,updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (SEGMENT_ID, SOURCE_ID, "原文", "", "", "", "", "", "", STAMP, STAMP),
    )
    connection.execute(
        "INSERT INTO chat_threads "
        "(id,segment_id,create_request_id,create_request_payload,permission_mode,"
        "revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
        (THREAD_ID, SEGMENT_ID, "thread", "{}", "review", 1, STAMP, STAMP),
    )


def insert_job(connection: sqlite3.Connection, job_id: str, status: str) -> None:
    connection.execute(
        "INSERT INTO chat_jobs "
        "(id,kind,thread_id,request_id,request_payload,status,input_snapshot,"
        "model_snapshot,permission_mode,created_at,version) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (job_id, "chat", THREAD_ID, job_id, "{}", status, "{}", "{}", "review", STAMP, 1),
    )


def insert_run(
    connection: sqlite3.Connection,
    run_id: str,
    job_id: str,
    *,
    purpose: str | None = "chat",
) -> None:
    purpose_column = "purpose," if purpose is not None else ""
    purpose_placeholder = "?," if purpose is not None else ""
    purpose_values = (purpose,) if purpose is not None else ()
    connection.execute(
        "INSERT INTO runs "
        f"({purpose_column}id,job_id,provider_id,provider_name,provider_revision,provider_model_id,"
        "model_revision,model_id,protocol,stream,status,output_text,prompt_version,"
        "prompt_text,base_url,created_at) "
        f"VALUES ({purpose_placeholder}?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            *purpose_values,
            run_id,
            job_id,
            SOURCE_ID,
            "Provider",
            1,
            SEGMENT_ID,
            1,
            "model",
            "responses",
            0,
            "succeeded",
            "输出",
            "v1",
            "提示",
            "http://localhost:9999/v1",
            STAMP,
        ),
    )


def table_snapshot(database: Path, tables: Sequence[str]) -> dict[str, list[tuple[Any, ...]]]:
    with sqlite3.connect(database) as connection:
        return {
            table: connection.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()
            for table in tables
        }
