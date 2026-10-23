"""Persist independent translation tasks, immutable results and adoption receipts."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0006_translations"
down_revision: str | None = "0005_segment_context_settings"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "translation_settings",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
    )
    op.create_table(
        "translation_tasks",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("request_id", sa.String(36), nullable=False, unique=True),
        sa.Column("request_payload", sa.Text(), nullable=False),
        sa.Column("source_id", sa.String(26), sa.ForeignKey("sources.id"), nullable=False),
        sa.Column("material_id", sa.String(26), sa.ForeignKey("materials.id"), nullable=False),
        sa.Column("identity_sha256", sa.String(64), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("token", sa.String(26)),
        sa.Column("result_id", sa.String(26)),
        sa.Column("run_id", sa.String(26)),
        sa.Column("error", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    for field in ("source_id", "material_id", "identity_sha256", "status"):
        op.create_index(f"ix_translation_tasks_{field}", "translation_tasks", [field])
    op.create_table(
        "translation_results",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column(
            "task_id",
            sa.String(26),
            sa.ForeignKey("translation_tasks.id"),
            nullable=False,
            unique=True,
        ),
        sa.Column("translation", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "translation_adoptions",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("request_id", sa.String(36), nullable=False, unique=True),
        sa.Column("request_payload", sa.Text(), nullable=False),
        sa.Column("adopted_payload", sa.Text(), nullable=False),
        sa.Column(
            "result_id", sa.String(26), sa.ForeignKey("translation_results.id"), nullable=False
        ),
        sa.Column("segment_id", sa.String(26), sa.ForeignKey("segments.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    for field in ("result_id", "segment_id"):
        op.create_index(f"ix_translation_adoptions_{field}", "translation_adoptions", [field])


def downgrade() -> None:
    connection = op.get_bind()
    for table in (
        "translation_adoptions",
        "translation_results",
        "translation_tasks",
        "translation_settings",
    ):
        if connection.execute(sa.text(f"SELECT 1 FROM {table} LIMIT 1")).first() is not None:
            raise RuntimeError("翻译记录已有数据，无法无损回退")
    for table in (
        "translation_adoptions",
        "translation_results",
        "translation_tasks",
        "translation_settings",
    ):
        op.drop_table(table)
