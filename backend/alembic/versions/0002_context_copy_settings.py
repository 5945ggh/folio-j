"""Persist independent context-copy defaults without changing existing data.

Revision ID: 0002_context_copy_settings
Revises: 0001_schema_baseline
"""

import sqlalchemy as sa

from alembic import op

revision = "0002_context_copy_settings"
down_revision = "0001_schema_baseline"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "context_copy_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("include_source", sa.Boolean(), nullable=False),
        sa.Column("before_sentences", sa.Integer(), nullable=False),
        sa.Column("after_sentences", sa.Integer(), nullable=False),
        sa.Column("before_characters", sa.Integer(), nullable=False),
        sa.Column("after_characters", sa.Integer(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.CheckConstraint("id = 1", name="ck_context_copy_singleton"),
        sa.CheckConstraint(
            "typeof(revision) = 'integer' AND revision >= 0", name="ck_context_copy_revision"
        ),
        sa.CheckConstraint("include_source IN (0, 1)", name="ck_context_copy_include_source"),
        *(
            sa.CheckConstraint(
                f"typeof({field}) = 'integer' AND {field} BETWEEN 0 AND 100000",
                name=f"ck_context_copy_{field}",
            )
            for field in (
                "before_sentences",
                "after_sentences",
                "before_characters",
                "after_characters",
            )
        ),
    )


def downgrade() -> None:
    op.drop_table("context_copy_settings")
