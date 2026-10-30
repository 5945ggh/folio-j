"""Add durable position bookmarks without rewriting existing content.

Revision ID: 0003_material_bookmarks
Revises: 0002_context_copy_settings
"""

import sqlalchemy as sa

from alembic import op

revision = "0003_material_bookmarks"
down_revision = "0002_context_copy_settings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "material_bookmarks",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("material_id", sa.String(26), sa.ForeignKey("materials.id"), nullable=False),
        sa.Column("version_id", sa.String(26), nullable=False),
        sa.Column("request_id", sa.String(36), nullable=False),
        *(
            sa.Column(name, sa.Text(), nullable=False)
            for name in ("request_payload", "position", "chapter_title", "excerpt", "note")
        ),
        *(
            sa.Column(name, sa.Integer(), nullable=False)
            for name in ("chapter_index", "part_index", "position_offset", "position_order")
        ),
        sa.Column("image_progress", sa.Float(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("material_id", "request_id", name="uq_material_bookmark_request"),
    )
    op.create_index(
        "ix_material_bookmark_order",
        "material_bookmarks",
        [
            "material_id",
            "version_id",
            "chapter_index",
            "part_index",
            "position_offset",
            "position_order",
            "image_progress",
            "id",
        ],
    )


def downgrade() -> None:
    op.drop_table("material_bookmarks")
