"""Persist segment conversations and accepted background work.

Revision ID: 0004_chat_jobs
Revises: 0003_model_identity
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0004_chat_jobs"
down_revision: str | None = "0003_model_identity"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("segments") as batch:
        batch.add_column(sa.Column("revision", sa.Integer(), nullable=False, server_default="1"))
    with op.batch_alter_table("runs") as batch:
        batch.add_column(
            sa.Column("purpose", sa.String(20), nullable=False, server_default="verification")
        )
        batch.add_column(sa.Column("job_id", sa.String(26), nullable=True))
        batch.add_column(sa.Column("messages", sa.JSON(), nullable=True))
        batch.add_column(sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("uq_runs_job_id", "runs", ["job_id"], unique=True)
    op.create_table(
        "chat_threads",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("segment_id", sa.String(26), sa.ForeignKey("segments.id"), nullable=False),
        sa.Column("create_request_id", sa.String(36), nullable=False),
        sa.Column("create_request_payload", sa.JSON(), nullable=False),
        sa.Column("selected_model_id", sa.String(26)),
        sa.Column("permission_mode", sa.String(20), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("active_job_id", sa.String(26)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_chat_threads_segment_id", "chat_threads", ["segment_id"])
    op.create_index(
        "uq_chat_thread_create", "chat_threads", ["segment_id", "create_request_id"], unique=True
    )
    op.create_table(
        "chat_jobs",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("kind", sa.String(30), nullable=False),
        sa.Column("thread_id", sa.String(26), sa.ForeignKey("chat_threads.id"), nullable=False),
        sa.Column("request_id", sa.String(36), nullable=False),
        sa.Column("request_payload", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("input_snapshot", sa.JSON(), nullable=False),
        sa.Column("model_snapshot", sa.JSON(), nullable=False),
        sa.Column("credential_ref", sa.String(26)),
        sa.Column("permission_mode", sa.String(20), nullable=False),
        sa.Column("execution_token", sa.String(26)),
        sa.Column("error_code", sa.String(40)),
        sa.Column("error", sa.Text()),
        sa.Column("stop_requested_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_chat_jobs_thread_id", "chat_jobs", ["thread_id"])
    op.create_index("ix_chat_jobs_status", "chat_jobs", ["status"])
    op.create_index("uq_chat_job_request", "chat_jobs", ["thread_id", "request_id"], unique=True)
    op.create_index(
        "uq_chat_job_active",
        "chat_jobs",
        ["thread_id"],
        unique=True,
        sqlite_where=sa.text("status IN ('queued','running','stopping') AND deleted_at IS NULL"),
    )
    op.create_table(
        "chat_messages",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("thread_id", sa.String(26), sa.ForeignKey("chat_threads.id"), nullable=False),
        sa.Column("job_id", sa.String(26), sa.ForeignKey("chat_jobs.id"), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(10), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_chat_messages_thread_id", "chat_messages", ["thread_id"])
    op.create_index("ix_chat_messages_job_id", "chat_messages", ["job_id"])
    op.create_index(
        "uq_chat_message_ordinal", "chat_messages", ["thread_id", "ordinal"], unique=True
    )
    op.create_index("uq_chat_message_job_role", "chat_messages", ["job_id", "role"], unique=True)


def downgrade() -> None:
    op.drop_table("chat_messages")
    op.drop_table("chat_jobs")
    op.drop_table("chat_threads")
    op.drop_index("uq_runs_job_id", table_name="runs")
    with op.batch_alter_table("runs") as batch:
        batch.drop_column("deleted_at")
        batch.drop_column("messages")
        batch.drop_column("job_id")
        batch.drop_column("purpose")
    with op.batch_alter_table("segments") as batch:
        batch.drop_column("revision")
