import hashlib
import sqlite3
from pathlib import Path
from typing import Any

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
