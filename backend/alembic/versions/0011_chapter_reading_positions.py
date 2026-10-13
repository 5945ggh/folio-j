"""Preserve book restoration and bootstrap only validated chapter anchors."""

import importlib.util
import json
from collections.abc import Sequence
from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision: str = "0011_chapter_positions"
down_revision: str | None = "0010_material_readings"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "chapter_reading_positions",
        sa.Column("material_id", sa.String(26), sa.ForeignKey("materials.id"), primary_key=True),
        sa.Column("chapter_id", sa.String(100), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    # Reuse the frozen historical validator rather than depending on evolving app code.
    spec = importlib.util.spec_from_file_location(
        "position_bootstrap", Path(__file__).with_name("0008_material_usage.py")
    )
    assert spec is not None and spec.loader is not None
    validator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(validator)
    connection = op.get_bind()
    rows = connection.execute(
        sa.text(
            "SELECT m.id,m.version_id,m.compiled_bundle,p.revision,p.payload,p.updated_at "
            "FROM materials m JOIN reading_positions p ON p.material_id=m.id"
        )
    )
    for row in rows:
        if row.revision <= 0 or not validator.valid_position(
            row.version_id, row.compiled_bundle, row.payload
        ):
            continue
        connection.execute(
            sa.text(
                "INSERT INTO chapter_reading_positions"
                "(material_id,chapter_id,revision,payload,updated_at) "
                "VALUES (:id,:chapter,:revision,:payload,:stamp)"
            ),
            {
                "id": row.id,
                "chapter": json.loads(row.payload)["chapter_id"],
                "revision": row.revision,
                "payload": row.payload,
                "stamp": row.updated_at,
            },
        )


def downgrade() -> None:
    op.drop_table("chapter_reading_positions")
