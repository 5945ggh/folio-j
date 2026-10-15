"""Retain immutable local token generations and atomically switch their pointer."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0010_material_readings"
down_revision: str | None = "0009_cover_rules"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "material_readings_generations",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("material_id", sa.String(26), sa.ForeignKey("materials.id"), nullable=False),
        sa.Column("version_id", sa.String(26), nullable=False),
        sa.Column("asset_sha256", sa.String(64), nullable=False),
        sa.Column("configuration", sa.Text(), nullable=False),
        sa.Column("token_count", sa.Integer(), nullable=False),
        sa.Column("payload", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("material_id", "version_id", "asset_sha256", name="uq_readings_asset"),
    )
    op.create_table(
        "material_readings_current",
        sa.Column("material_id", sa.String(26), sa.ForeignKey("materials.id"), primary_key=True),
        sa.Column(
            "generation_id",
            sa.String(26),
            sa.ForeignKey("material_readings_generations.id"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_table("material_readings_current")
    op.drop_table("material_readings_generations")
