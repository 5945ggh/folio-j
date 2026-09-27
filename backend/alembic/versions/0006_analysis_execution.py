"""Allow multiple model calls and durable analysis job state.

Revision ID: 0006_analysis_execution
Revises: 0005_analyses
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0006_analysis_execution"
down_revision: str | None = "0005_analyses"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("chat_jobs") as batch:
        batch.add_column(
            sa.Column("execution_state", sa.JSON(), nullable=False, server_default="{}")
        )
    with op.batch_alter_table("runs") as batch:
        batch.alter_column("prompt_version", type_=sa.String(64), existing_type=sa.String(20))
    op.drop_index("uq_runs_job_id", table_name="runs")
    op.create_index("ix_runs_job_id", "runs", ["job_id"])
    op.drop_index("uq_chat_job_active", table_name="chat_jobs")
    op.create_index(
        "uq_chat_job_active",
        "chat_jobs",
        ["thread_id"],
        unique=True,
        sqlite_where=sa.text(
            "status IN ('queued','running','waiting_review','stopping') AND deleted_at IS NULL"
        ),
    )


def downgrade() -> None:
    op.drop_index("uq_chat_job_active", table_name="chat_jobs")
    op.create_index(
        "uq_chat_job_active",
        "chat_jobs",
        ["thread_id"],
        unique=True,
        sqlite_where=sa.text("status IN ('queued','running','stopping') AND deleted_at IS NULL"),
    )
    op.drop_index("ix_runs_job_id", table_name="runs")
    op.create_index("uq_runs_job_id", "runs", ["job_id"], unique=True)
    with op.batch_alter_table("chat_jobs") as batch:
        batch.drop_column("execution_state")
    with op.batch_alter_table("runs") as batch:
        batch.alter_column("prompt_version", type_=sa.String(20), existing_type=sa.String(64))
