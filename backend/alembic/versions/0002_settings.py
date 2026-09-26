"""Add learner settings, model access and validation runs.

Revision ID: 0002_settings
Revises: 0001_source_segment
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0002_settings"
down_revision: str | None = "0001_source_segment"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "learner_profile",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("native_language", sa.String(100), nullable=False),
        sa.Column("explain_language", sa.String(100), nullable=False),
        sa.Column("level_note", sa.Text(), nullable=False),
    )
    op.create_table(
        "explanation_styles",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("body_md", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "settings_defaults",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("analysis_model_id", sa.String(26)),
        sa.Column("chat_model_id", sa.String(26)),
        sa.Column("extraction_model_id", sa.String(26)),
        sa.Column("style_id", sa.String(26)),
        sa.Column("permission_mode", sa.String(20), nullable=False),
    )
    op.create_table(
        "providers",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("base_url", sa.String(2048), nullable=False),
        sa.Column("protocol", sa.String(30), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("credential_ref", sa.String(26)),
        sa.Column("discovered_models", sa.JSON(), nullable=False),
        sa.Column("discovery_status", sa.String(20), nullable=False),
        sa.Column("discovery_error", sa.Text()),
        sa.Column("last_discovered_at", sa.DateTime(timezone=True)),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
    )
    op.create_table(
        "provider_models",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("provider_id", sa.String(26), sa.ForeignKey("providers.id"), nullable=False),
        sa.Column("model_id", sa.String(200), nullable=False),
        sa.Column("protocol_override", sa.String(30)),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("temperature", sa.Float()),
        sa.Column("max_output_tokens", sa.Integer()),
        sa.Column("reasoning_effort", sa.String(10)),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("text_status", sa.String(20), nullable=False),
        sa.Column("stream_status", sa.String(20), nullable=False),
    )
    op.create_index("ix_provider_models_provider_id", "provider_models", ["provider_id"])
    op.create_table(
        "runs",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("provider_id", sa.String(26), nullable=False),
        sa.Column("provider_name", sa.String(100), nullable=False),
        sa.Column("provider_revision", sa.Integer(), nullable=False),
        sa.Column("provider_model_id", sa.String(26), nullable=False),
        sa.Column("model_revision", sa.Integer(), nullable=False),
        sa.Column("model_id", sa.String(200), nullable=False),
        sa.Column("protocol", sa.String(30), nullable=False),
        sa.Column("stream", sa.Boolean(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("output_text", sa.Text(), nullable=False),
        sa.Column("error", sa.Text()),
        sa.Column("usage", sa.JSON()),
        sa.Column("prompt_version", sa.String(20), nullable=False),
        sa.Column("prompt_text", sa.Text(), nullable=False),
        sa.Column("base_url", sa.String(2048), nullable=False),
        sa.Column("credential_ref", sa.String(26)),
        sa.Column("temperature", sa.Float()),
        sa.Column("max_output_tokens", sa.Integer()),
        sa.Column("reasoning_effort", sa.String(10)),
        sa.Column("raw_response", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_runs_provider_id", "runs", ["provider_id"])
    op.create_index("ix_runs_status", "runs", ["status"])


def downgrade() -> None:
    op.drop_index("ix_runs_status", table_name="runs")
    op.drop_index("ix_runs_provider_id", table_name="runs")
    op.drop_table("runs")
    op.drop_index("ix_provider_models_provider_id", table_name="provider_models")
    op.drop_table("provider_models")
    op.drop_table("providers")
    op.drop_table("settings_defaults")
    op.drop_table("explanation_styles")
    op.drop_table("learner_profile")
