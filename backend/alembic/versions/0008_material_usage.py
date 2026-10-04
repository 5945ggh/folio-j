"""Preserve immutable books; conservative valid-position usage bootstrap and cover cache."""

import json
import re
import zlib
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0008_material_usage"
down_revision: str | None = "0007_materials"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def valid_position(version: str, compiled: bytes, payload: str) -> bool:
    """Do not infer progress from invalid, stale or mismatched old anchors."""
    try:
        book = json.loads(zlib.decompress(compiled))
        position = json.loads(payload)
        if position["version_id"] != version:
            return False
        chapter = next(c for c in book["chapters"] if c["id"] == position["chapter_id"])
        index = position["part_index"]
        if not isinstance(index, int) or index < 0 or index >= len(chapter["parts"]):
            return False
        part = chapter["parts"][index]
        if position["resource_id"] != part["resource_id"]:
            return False
        if position["kind"] == "text":
            offset = position.get("offset")
            return (
                isinstance(offset, int)
                and part["start"] <= offset <= part["end"]
                and position.get("image_id") is None
                and position.get("image_progress") is None
            )
        if position["kind"] == "image":
            progress = position.get("image_progress")
            return (
                position.get("offset") is None
                and isinstance(progress, (float, int))
                and 0 <= progress <= 1
                and str(position.get("image_id"))
                in re.findall(r'data-epub-image=["\'](\d+)["\']', part["html"])
            )
        return False
    except (ValueError, KeyError, TypeError, StopIteration, zlib.error, IndexError):
        return False


def upgrade() -> None:
    op.create_table(
        "material_usage",
        sa.Column("material_id", sa.String(26), sa.ForeignKey("materials.id"), primary_key=True),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("last_opened_at", sa.DateTime(timezone=True)),
        sa.Column("last_action_id", sa.String(100)),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_material_usage_last_opened_at", "material_usage", ["last_opened_at"])
    op.create_table(
        "material_covers",
        sa.Column("material_id", sa.String(26), sa.ForeignKey("materials.id"), primary_key=True),
        sa.Column("media_type", sa.String(40)),
        sa.Column("data", sa.LargeBinary()),
    )
    connection = op.get_bind()
    rows = connection.execute(
        sa.text(
            "SELECT m.id,m.version_id,m.compiled_bundle,m.created_at,p.payload,p.revision "
            "FROM materials m LEFT JOIN reading_positions p ON p.material_id=m.id"
        )
    )
    for row in rows:
        started = (
            row.payload is not None
            and row.revision > 0
            and valid_position(row.version_id, row.compiled_bundle, row.payload)
        )
        connection.execute(
            sa.text(
                "INSERT INTO material_usage(material_id,status,revision,last_opened_at,"
                "last_action_id,updated_at) VALUES (:id,:status,0,NULL,NULL,:stamp)"
            ),
            {
                "id": row.id,
                "status": "in_progress" if started else "not_started",
                "stamp": row.created_at,
            },
        )


def downgrade() -> None:
    op.drop_table("material_covers")
    op.drop_index("ix_material_usage_last_opened_at", table_name="material_usage")
    op.drop_table("material_usage")
