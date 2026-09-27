"""Persist Analysis documents and immutable revisions.

Revision ID: 0005_analyses
Revises: 0004_chat_jobs
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0005_analyses"
down_revision: str | None = "0004_chat_jobs"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "analyses",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("segment_id", sa.String(26), sa.ForeignKey("segments.id"), nullable=False),
        sa.Column("operation_key", sa.String(100), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("excerpt", sa.String(240), nullable=False),
        sa.Column("current_revision_id", sa.String(26), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("operation_key", name="uq_analysis_operation"),
    )
    op.create_index("ix_analyses_segment_id", "analyses", ["segment_id"])
    op.create_table(
        "analysis_revisions",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("analysis_id", sa.String(26), sa.ForeignKey("analyses.id"), nullable=False),
        sa.Column("parent_revision_id", sa.String(26), sa.ForeignKey("analysis_revisions.id")),
        sa.Column("operation_key", sa.String(100), nullable=False),
        sa.Column("operation_payload", sa.JSON(), nullable=False),
        sa.Column("origin", sa.String(40), nullable=False),
        sa.Column("run_id", sa.String(26)),
        sa.Column("source_md", sa.Text(), nullable=False),
        sa.Column("normalizer_version", sa.Integer(), nullable=False),
        sa.Column("warnings", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("operation_key", name="uq_analysis_revision_operation"),
    )
    op.create_index("ix_analysis_revisions_analysis_id", "analysis_revisions", ["analysis_id"])
    op.create_table(
        "analysis_sections",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column(
            "revision_id", sa.String(26), sa.ForeignKey("analysis_revisions.id"), nullable=False
        ),
        sa.Column("uid", sa.String(26), nullable=False),
        sa.Column("handle", sa.String(12), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("display_no", sa.String(20), nullable=False),
        sa.Column("title", sa.String(500)),
        sa.Column("start_line", sa.Integer(), nullable=False),
        sa.Column("end_line", sa.Integer(), nullable=False),
        sa.Column("raw", sa.Text(), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.UniqueConstraint("revision_id", "uid", name="uq_section_revision_uid"),
    )
    op.create_index("ix_analysis_sections_revision_id", "analysis_sections", ["revision_id"])


def downgrade() -> None:
    op.drop_table("analysis_sections")
    op.drop_table("analysis_revisions")
    op.drop_table("analyses")
