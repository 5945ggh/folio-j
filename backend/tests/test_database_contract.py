"""Database constraints keep accepted work and provider identities unambiguous."""

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest
from support_database import (
    JOB_ID,
    RUN_ID,
    SEGMENT_ID,
    SOURCE_ID,
    STAMP,
    THREAD_ID,
    insert_discussion,
    insert_job,
    insert_run,
    rebuild_database,
)


@pytest.fixture
def database_connection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[sqlite3.Connection]:
    database = tmp_path / "contract.db"
    rebuild_database(database, monkeypatch)
    with sqlite3.connect(database) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        yield connection
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


@pytest.mark.parametrize("status", ["queued", "running", "waiting_review", "stopping"])
def test_active_job_reserves_thread_until_soft_deleted(
    database_connection: sqlite3.Connection, status: str
) -> None:
    connection = database_connection
    insert_discussion(connection)
    insert_job(connection, JOB_ID, status)
    replacement_id = "01ARZ3NDEKTSV4RRFFQ69G5FB0"
    with pytest.raises(sqlite3.IntegrityError, match="chat_jobs.thread_id"):
        insert_job(connection, replacement_id, "queued")
    connection.execute("UPDATE chat_jobs SET deleted_at=? WHERE id=?", (STAMP, JOB_ID))
    insert_job(connection, replacement_id, "queued")
    assert connection.execute("SELECT count(*) FROM chat_jobs").fetchone() == (2,)


def test_job_retains_multiple_model_calls(database_connection: sqlite3.Connection) -> None:
    connection = database_connection
    insert_discussion(connection)
    insert_job(connection, JOB_ID, "succeeded")
    insert_run(connection, RUN_ID, JOB_ID)
    insert_run(connection, "01ARZ3NDEKTSV4RRFFQ69G5FB0", JOB_ID)
    assert connection.execute("SELECT count(*) FROM runs WHERE job_id=?", (JOB_ID,)).fetchone() == (
        2,
    )


def test_model_identity_is_unique_within_provider_only(
    database_connection: sqlite3.Connection,
) -> None:
    connection = database_connection
    for provider_id in (SOURCE_ID, SEGMENT_ID):
        connection.execute(
            "INSERT INTO providers "
            "(id,name,base_url,protocol,enabled,discovered_models,discovery_status,"
            "revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                provider_id,
                "Provider",
                "http://localhost/v1",
                "responses",
                1,
                "[]",
                "never",
                1,
                STAMP,
                STAMP,
            ),
        )
    insert_model = (
        "INSERT INTO provider_models "
        "(id,provider_id,model_id,enabled,revision,text_status,stream_status) "
        "VALUES (?,?,?,1,1,'unknown','unknown')"
    )
    connection.execute(insert_model, (THREAD_ID, SOURCE_ID, "shared-model"))
    connection.execute(insert_model, (JOB_ID, SEGMENT_ID, "shared-model"))
    with pytest.raises(sqlite3.IntegrityError, match="provider_models.provider_id"):
        connection.execute(insert_model, (RUN_ID, SOURCE_ID, "shared-model"))
    assert connection.execute("SELECT count(*) FROM provider_models").fetchone() == (2,)


def test_sql_insert_defaults_remain_available(database_connection: sqlite3.Connection) -> None:
    connection = database_connection
    insert_discussion(connection)
    insert_job(connection, JOB_ID, "succeeded")
    insert_run(connection, RUN_ID, JOB_ID, purpose=None)
    assert connection.execute("SELECT revision FROM segments").fetchone() == (1,)
    assert connection.execute("SELECT purpose FROM runs").fetchone() == ("verification",)
    assert connection.execute("SELECT execution_state FROM chat_jobs").fetchone() == ("{}",)
    connection.execute(
        "INSERT INTO materials "
        "(id,source_id,title,source_sha256,version_id,product_sha256,contract_version,"
        "original_bytes,warnings,compiled_bundle,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (
            SEGMENT_ID,
            SOURCE_ID,
            "书",
            "a" * 64,
            THREAD_ID,
            "b" * 64,
            "v1",
            b"original",
            "[]",
            b"bundle",
            STAMP,
        ),
    )
    connection.execute("INSERT INTO material_covers (material_id) VALUES (?)", (SEGMENT_ID,))
    assert connection.execute("SELECT metadata_revision FROM materials").fetchone() == (0,)
    assert connection.execute(
        "SELECT rule_version,diagnostic_reason FROM material_covers"
    ).fetchone() == (1, "legacy_cache")
