import json
import sqlite3
from pathlib import Path
from typing import Any


def accepted_input(database: Path, job_id: str) -> dict[str, Any]:
    with sqlite3.connect(database) as connection:
        row = connection.execute(
            "SELECT input_snapshot FROM chat_jobs WHERE id = ?", (job_id,)
        ).fetchone()
    assert row is not None
    return json.loads(row[0])


def snapshot_bytes(database: Path, job_id: str) -> bytes:
    with sqlite3.connect(database) as connection:
        row = connection.execute(
            "SELECT CAST(input_snapshot AS BLOB) FROM chat_jobs WHERE id=?", (job_id,)
        ).fetchone()
    assert row is not None and isinstance(row[0], bytes)
    return row[0]


def stored_origin(database: Path, segment_id: str) -> tuple[Any, ...]:
    with sqlite3.connect(database) as connection:
        row = connection.execute(
            "SELECT * FROM segment_material_provenance WHERE segment_id=?", (segment_id,)
        ).fetchone()
    assert row is not None
    return row
