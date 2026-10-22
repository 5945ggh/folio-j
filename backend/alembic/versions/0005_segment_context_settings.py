"""Store reading-context defaults independently of existing learning records.

Revision ID: 0005_segment_context_settings
Revises: 0004_segment_material_provenance
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0005_segment_context_settings"
down_revision: str | None = "0004_segment_material_provenance"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "segment_context_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("before_sentences", sa.Integer(), nullable=False),
        sa.Column("after_sentences", sa.Integer(), nullable=False),
        sa.Column("before_characters", sa.Integer(), nullable=False),
        sa.Column("after_characters", sa.Integer(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.CheckConstraint("id = 1", name="ck_segment_context_singleton"),
        sa.CheckConstraint("revision >= 0", name="ck_segment_context_revision"),
        *(
            sa.CheckConstraint(f"{field} BETWEEN 0 AND 100000", name=f"ck_segment_context_{field}")
            for field in (
                "before_sentences",
                "after_sentences",
                "before_characters",
                "after_characters",
            )
        ),
    )


def downgrade() -> None:
    if op.get_bind().execute(sa.text("SELECT 1 FROM segment_context_settings LIMIT 1")).first():
        raise RuntimeError("已有学习片段语境配置，无法无损回退；请保留当前版本或从备份恢复")
    op.drop_table("segment_context_settings")
