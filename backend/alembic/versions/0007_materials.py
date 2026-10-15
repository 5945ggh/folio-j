"""Preserve existing learning data while adding managed EPUB materials."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0007_materials"
down_revision: str | None = "0006_analysis_execution"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "materials",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("source_id", sa.String(26), sa.ForeignKey("sources.id"), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("source_sha256", sa.String(64), nullable=False),
        sa.Column("version_id", sa.String(26), nullable=False, unique=True),
        sa.Column("product_sha256", sa.String(64), nullable=False),
        sa.Column("contract_version", sa.String(64), nullable=False),
        sa.Column("original_bytes", sa.LargeBinary(), nullable=False),
        sa.Column("warnings", sa.JSON(), nullable=False),
        sa.Column("compiled_bundle", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("source_id", "source_sha256", name="uq_material_source_bytes"),
    )
    op.create_index("ix_materials_source_id", "materials", ["source_id"])
    op.create_table(
        "reading_positions",
        sa.Column("material_id", sa.String(26), sa.ForeignKey("materials.id"), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("reading_positions")
    op.drop_index("ix_materials_source_id", table_name="materials")
    op.drop_table("materials")
