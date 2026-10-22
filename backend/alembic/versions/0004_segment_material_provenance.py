"""Preserve exact Segment origins without rewriting existing learning content.

Revision ID: 0004_segment_material_provenance
Revises: 0003_material_soft_delete
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0004_segment_material_provenance"
down_revision: str | None = "0003_material_soft_delete"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "segment_material_provenance",
        sa.Column("segment_id", sa.String(26), sa.ForeignKey("segments.id"), primary_key=True),
        sa.Column("source_id", sa.String(26), sa.ForeignKey("sources.id"), nullable=False),
        sa.Column("material_id", sa.String(26), sa.ForeignKey("materials.id"), nullable=False),
        sa.Column("version_id", sa.String(26), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("identity_sha256", sa.String(64), nullable=False),
        sa.Column("request_id", sa.String(36), nullable=False),
        sa.Column("request_payload", sa.Text(), nullable=False),
        sa.Column("assembly_rule", sa.String(40), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("source_id", "request_id", name="uq_segment_provenance_request"),
    )
    op.create_index(
        "ix_segment_material_provenance_identity_sha256",
        "segment_material_provenance",
        ["identity_sha256"],
    )


def downgrade() -> None:
    if op.get_bind().execute(sa.text("SELECT 1 FROM segment_material_provenance LIMIT 1")).first():
        raise RuntimeError("已有精确材料出处，无法无损回退；请保留当前版本或从备份恢复")
    op.drop_index("ix_segment_material_provenance_identity_sha256", "segment_material_provenance")
    op.drop_table("segment_material_provenance")
