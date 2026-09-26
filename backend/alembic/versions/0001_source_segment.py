"""Create the initial Source and Segment schema.

Revision ID: 0001_source_segment
Revises:
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0001_source_segment"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "sources",
        sa.Column("id", sa.String(length=26), primary_key=True),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_table(
        "segments",
        sa.Column("id", sa.String(length=26), primary_key=True),
        sa.Column("source_id", sa.String(length=26), sa.ForeignKey("sources.id"), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("translation", sa.Text(), nullable=False),
        sa.Column("context_before", sa.Text(), nullable=False),
        sa.Column("context_after", sa.Text(), nullable=False),
        sa.Column("transcription", sa.Text(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("source_ref", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("text_locked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_segments_source_id", "segments", ["source_id"])


def downgrade() -> None:
    op.drop_index("ix_segments_source_id", table_name="segments")
    op.drop_table("segments")
    op.drop_table("sources")
