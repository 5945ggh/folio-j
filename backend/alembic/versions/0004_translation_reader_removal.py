"""Preserve reader translation removal independently from immutable results.

Revision ID: 0004_translation_reader_removal
Revises: 0003_material_bookmarks
"""

import sqlalchemy as sa

from alembic import op

revision = "0004_translation_reader_removal"
down_revision = "0003_material_bookmarks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "translation_tasks",
        sa.Column("reader_deleted_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("translation_tasks", "reader_deleted_at")
