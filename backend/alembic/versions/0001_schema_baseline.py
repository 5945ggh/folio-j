"""Create the complete application schema from an empty database.

Revision ID: 0001_schema_baseline
Revises:

This fixed DDL baseline does not import runtime models or replay development backfills.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0001_schema_baseline"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "explanation_styles",
        sa.Column("id", sa.String(length=26), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("body_md", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "learner_profile",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("native_language", sa.String(length=100), nullable=False),
        sa.Column("explain_language", sa.String(length=100), nullable=False),
        sa.Column("level_note", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "providers",
        sa.Column("id", sa.String(length=26), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("base_url", sa.String(length=2048), nullable=False),
        sa.Column("protocol", sa.String(length=30), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("credential_ref", sa.String(length=26), nullable=True),
        sa.Column("discovered_models", sa.JSON(), nullable=False),
        sa.Column("discovery_status", sa.String(length=20), nullable=False),
        sa.Column("discovery_error", sa.Text(), nullable=True),
        sa.Column("last_discovered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "runs",
        sa.Column("id", sa.String(length=26), nullable=False),
        sa.Column("provider_id", sa.String(length=26), nullable=False),
        sa.Column("provider_name", sa.String(length=100), nullable=False),
        sa.Column("provider_revision", sa.Integer(), nullable=False),
        sa.Column("provider_model_id", sa.String(length=26), nullable=False),
        sa.Column("model_revision", sa.Integer(), nullable=False),
        sa.Column("model_id", sa.String(length=200), nullable=False),
        sa.Column("protocol", sa.String(length=30), nullable=False),
        sa.Column("stream", sa.Boolean(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("output_text", sa.Text(), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("usage", sa.JSON(), nullable=True),
        sa.Column("prompt_version", sa.String(length=64), nullable=False),
        sa.Column("prompt_text", sa.Text(), nullable=False),
        sa.Column("base_url", sa.String(length=2048), nullable=False),
        sa.Column("credential_ref", sa.String(length=26), nullable=True),
        sa.Column("temperature", sa.Float(), nullable=True),
        sa.Column("max_output_tokens", sa.Integer(), nullable=True),
        sa.Column("reasoning_effort", sa.String(length=10), nullable=True),
        sa.Column("raw_response", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "purpose",
            sa.String(length=20),
            server_default=sa.text("'verification'"),
            nullable=False,
        ),
        sa.Column("job_id", sa.String(length=26), nullable=True),
        sa.Column("messages", sa.JSON(), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_runs_job_id", "runs", ["job_id"], unique=False)
    op.create_index("ix_runs_provider_id", "runs", ["provider_id"], unique=False)
    op.create_index("ix_runs_status", "runs", ["status"], unique=False)
    op.create_table(
        "settings_defaults",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("analysis_model_id", sa.String(length=26), nullable=True),
        sa.Column("chat_model_id", sa.String(length=26), nullable=True),
        sa.Column("extraction_model_id", sa.String(length=26), nullable=True),
        sa.Column("style_id", sa.String(length=26), nullable=True),
        sa.Column("permission_mode", sa.String(length=20), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "sources",
        sa.Column("id", sa.String(length=26), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "materials",
        sa.Column("id", sa.String(length=26), nullable=False),
        sa.Column("source_id", sa.String(length=26), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("source_sha256", sa.String(length=64), nullable=False),
        sa.Column("version_id", sa.String(length=26), nullable=False),
        sa.Column("product_sha256", sa.String(length=64), nullable=False),
        sa.Column("contract_version", sa.String(length=64), nullable=False),
        sa.Column("original_bytes", sa.LargeBinary(), nullable=False),
        sa.Column("warnings", sa.JSON(), nullable=False),
        sa.Column("compiled_bundle", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("metadata_revision", sa.Integer(), server_default=sa.text("'0'"), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["source_id"],
            ["sources.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("version_id"),
    )
    op.create_index("ix_materials_source_id", "materials", ["source_id"], unique=False)
    op.create_index(
        "uq_material_source_bytes",
        "materials",
        ["source_id", "source_sha256"],
        unique=True,
        sqlite_where=sa.text("deleted_at IS NULL"),
    )
    op.create_table(
        "provider_models",
        sa.Column("id", sa.String(length=26), nullable=False),
        sa.Column("provider_id", sa.String(length=26), nullable=False),
        sa.Column("model_id", sa.String(length=200), nullable=False),
        sa.Column("protocol_override", sa.String(length=30), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("temperature", sa.Float(), nullable=True),
        sa.Column("max_output_tokens", sa.Integer(), nullable=True),
        sa.Column("reasoning_effort", sa.String(length=10), nullable=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("text_status", sa.String(length=20), nullable=False),
        sa.Column("stream_status", sa.String(length=20), nullable=False),
        sa.ForeignKeyConstraint(
            ["provider_id"],
            ["providers.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_provider_models_provider_id", "provider_models", ["provider_id"], unique=False
    )
    op.create_index(
        "uq_provider_models_identity", "provider_models", ["provider_id", "model_id"], unique=True
    )
    op.create_table(
        "segments",
        sa.Column("id", sa.String(length=26), nullable=False),
        sa.Column("source_id", sa.String(length=26), nullable=False),
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
        sa.Column("revision", sa.Integer(), server_default=sa.text("'1'"), nullable=False),
        sa.ForeignKeyConstraint(
            ["source_id"],
            ["sources.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_segments_source_id", "segments", ["source_id"], unique=False)
    op.create_table(
        "analyses",
        sa.Column("id", sa.String(length=26), nullable=False),
        sa.Column("segment_id", sa.String(length=26), nullable=False),
        sa.Column("operation_key", sa.String(length=100), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("excerpt", sa.String(length=240), nullable=False),
        sa.Column("current_revision_id", sa.String(length=26), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["segment_id"],
            ["segments.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("operation_key", name="uq_analysis_operation"),
    )
    op.create_index("ix_analyses_segment_id", "analyses", ["segment_id"], unique=False)
    op.create_table(
        "chapter_reading_positions",
        sa.Column("material_id", sa.String(length=26), nullable=False),
        sa.Column("chapter_id", sa.String(length=100), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["material_id"],
            ["materials.id"],
        ),
        sa.PrimaryKeyConstraint("material_id", "chapter_id"),
    )
    op.create_table(
        "chat_threads",
        sa.Column("id", sa.String(length=26), nullable=False),
        sa.Column("segment_id", sa.String(length=26), nullable=False),
        sa.Column("create_request_id", sa.String(length=36), nullable=False),
        sa.Column("create_request_payload", sa.JSON(), nullable=False),
        sa.Column("selected_model_id", sa.String(length=26), nullable=True),
        sa.Column("permission_mode", sa.String(length=20), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("active_job_id", sa.String(length=26), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["segment_id"],
            ["segments.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_chat_threads_segment_id", "chat_threads", ["segment_id"], unique=False)
    op.create_index(
        "uq_chat_thread_create", "chat_threads", ["segment_id", "create_request_id"], unique=True
    )
    op.create_table(
        "material_covers",
        sa.Column("material_id", sa.String(length=26), nullable=False),
        sa.Column("media_type", sa.String(length=40), nullable=True),
        sa.Column("data", sa.LargeBinary(), nullable=True),
        sa.Column("rule_version", sa.Integer(), server_default=sa.text("'1'"), nullable=False),
        sa.Column(
            "diagnostic_reason", sa.Text(), server_default=sa.text("'legacy_cache'"), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["material_id"],
            ["materials.id"],
        ),
        sa.PrimaryKeyConstraint("material_id"),
    )
    op.create_table(
        "material_custom_covers",
        sa.Column("material_id", sa.String(length=26), nullable=False),
        sa.Column("media_type", sa.String(length=40), nullable=False),
        sa.Column("data", sa.LargeBinary(), nullable=False),
        sa.ForeignKeyConstraint(
            ["material_id"],
            ["materials.id"],
        ),
        sa.PrimaryKeyConstraint("material_id"),
    )
    op.create_table(
        "material_readings_generations",
        sa.Column("id", sa.String(length=26), nullable=False),
        sa.Column("material_id", sa.String(length=26), nullable=False),
        sa.Column("version_id", sa.String(length=26), nullable=False),
        sa.Column("asset_sha256", sa.String(length=64), nullable=False),
        sa.Column("configuration", sa.Text(), nullable=False),
        sa.Column("token_count", sa.Integer(), nullable=False),
        sa.Column("payload", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["material_id"],
            ["materials.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("material_id", "version_id", "asset_sha256", name="uq_readings_asset"),
    )
    op.create_table(
        "material_usage",
        sa.Column("material_id", sa.String(length=26), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("last_opened_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_action_id", sa.String(length=100), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["material_id"],
            ["materials.id"],
        ),
        sa.PrimaryKeyConstraint("material_id"),
    )
    op.create_index(
        "ix_material_usage_last_opened_at", "material_usage", ["last_opened_at"], unique=False
    )
    op.create_table(
        "reading_positions",
        sa.Column("material_id", sa.String(length=26), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["material_id"],
            ["materials.id"],
        ),
        sa.PrimaryKeyConstraint("material_id"),
    )
    op.create_table(
        "analysis_revisions",
        sa.Column("id", sa.String(length=26), nullable=False),
        sa.Column("analysis_id", sa.String(length=26), nullable=False),
        sa.Column("parent_revision_id", sa.String(length=26), nullable=True),
        sa.Column("operation_key", sa.String(length=100), nullable=False),
        sa.Column("operation_payload", sa.JSON(), nullable=False),
        sa.Column("origin", sa.String(length=40), nullable=False),
        sa.Column("run_id", sa.String(length=26), nullable=True),
        sa.Column("source_md", sa.Text(), nullable=False),
        sa.Column("normalizer_version", sa.Integer(), nullable=False),
        sa.Column("warnings", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["analysis_id"],
            ["analyses.id"],
        ),
        sa.ForeignKeyConstraint(
            ["parent_revision_id"],
            ["analysis_revisions.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("operation_key", name="uq_analysis_revision_operation"),
    )
    op.create_index(
        "ix_analysis_revisions_analysis_id", "analysis_revisions", ["analysis_id"], unique=False
    )
    op.create_table(
        "chat_jobs",
        sa.Column("id", sa.String(length=26), nullable=False),
        sa.Column("kind", sa.String(length=30), nullable=False),
        sa.Column("thread_id", sa.String(length=26), nullable=False),
        sa.Column("request_id", sa.String(length=36), nullable=False),
        sa.Column("request_payload", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("input_snapshot", sa.JSON(), nullable=False),
        sa.Column("model_snapshot", sa.JSON(), nullable=False),
        sa.Column("credential_ref", sa.String(length=26), nullable=True),
        sa.Column("permission_mode", sa.String(length=20), nullable=False),
        sa.Column("execution_token", sa.String(length=26), nullable=True),
        sa.Column("error_code", sa.String(length=40), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("stop_requested_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("execution_state", sa.JSON(), server_default=sa.text("'{}'"), nullable=False),
        sa.ForeignKeyConstraint(
            ["thread_id"],
            ["chat_threads.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_chat_jobs_status", "chat_jobs", ["status"], unique=False)
    op.create_index("ix_chat_jobs_thread_id", "chat_jobs", ["thread_id"], unique=False)
    op.create_index(
        "uq_chat_job_active",
        "chat_jobs",
        ["thread_id"],
        unique=True,
        sqlite_where=sa.text(
            "status IN ('queued','running','waiting_review','stopping') AND deleted_at IS NULL"
        ),
    )
    op.create_index("uq_chat_job_request", "chat_jobs", ["thread_id", "request_id"], unique=True)
    op.create_table(
        "material_readings_current",
        sa.Column("material_id", sa.String(length=26), nullable=False),
        sa.Column("generation_id", sa.String(length=26), nullable=False),
        sa.ForeignKeyConstraint(
            ["generation_id"],
            ["material_readings_generations.id"],
        ),
        sa.ForeignKeyConstraint(
            ["material_id"],
            ["materials.id"],
        ),
        sa.PrimaryKeyConstraint("material_id"),
    )
    op.create_table(
        "analysis_sections",
        sa.Column("id", sa.String(length=26), nullable=False),
        sa.Column("revision_id", sa.String(length=26), nullable=False),
        sa.Column("uid", sa.String(length=26), nullable=False),
        sa.Column("handle", sa.String(length=12), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("display_no", sa.String(length=20), nullable=False),
        sa.Column("title", sa.String(length=500), nullable=True),
        sa.Column("start_line", sa.Integer(), nullable=False),
        sa.Column("end_line", sa.Integer(), nullable=False),
        sa.Column("raw", sa.Text(), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["revision_id"],
            ["analysis_revisions.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("revision_id", "uid", name="uq_section_revision_uid"),
    )
    op.create_index(
        "ix_analysis_sections_revision_id", "analysis_sections", ["revision_id"], unique=False
    )
    op.create_table(
        "chat_messages",
        sa.Column("id", sa.String(length=26), nullable=False),
        sa.Column("thread_id", sa.String(length=26), nullable=False),
        sa.Column("job_id", sa.String(length=26), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(length=10), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["job_id"],
            ["chat_jobs.id"],
        ),
        sa.ForeignKeyConstraint(
            ["thread_id"],
            ["chat_threads.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_chat_messages_job_id", "chat_messages", ["job_id"], unique=False)
    op.create_index("ix_chat_messages_thread_id", "chat_messages", ["thread_id"], unique=False)
    op.create_index("uq_chat_message_job_role", "chat_messages", ["job_id", "role"], unique=True)
    op.create_index(
        "uq_chat_message_ordinal", "chat_messages", ["thread_id", "ordinal"], unique=True
    )

    op.create_table(
        "segment_material_provenance",
        sa.Column("segment_id", sa.String(26), sa.ForeignKey("segments.id"), primary_key=True),
        sa.Column("source_id", sa.String(26), sa.ForeignKey("sources.id"), nullable=False),
        sa.Column("material_id", sa.String(26), sa.ForeignKey("materials.id"), nullable=False),
        sa.Column("version_id", sa.String(26), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("identity_sha256", sa.String(64), nullable=False),
        sa.Column("request_id", sa.String(36), nullable=False),
        sa.Column("request_payload", sa.Text(), nullable=False),
        sa.Column("assembly_rule", sa.String(40), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("source_id", "request_id", name="uq_segment_provenance_request"),
    )
    op.create_index(
        "ix_segment_material_provenance_identity_sha256",
        "segment_material_provenance",
        ["identity_sha256"],
    )

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
        sa.CheckConstraint(
            "before_sentences BETWEEN 0 AND 100000", name="ck_segment_context_before_sentences"
        ),
        sa.CheckConstraint(
            "after_sentences BETWEEN 0 AND 100000", name="ck_segment_context_after_sentences"
        ),
        sa.CheckConstraint(
            "before_characters BETWEEN 0 AND 100000", name="ck_segment_context_before_characters"
        ),
        sa.CheckConstraint(
            "after_characters BETWEEN 0 AND 100000", name="ck_segment_context_after_characters"
        ),
    )

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
    op.create_index("ix_translation_tasks_source_id", "translation_tasks", ["source_id"])
    op.create_index("ix_translation_tasks_material_id", "translation_tasks", ["material_id"])
    op.create_index(
        "ix_translation_tasks_identity_sha256", "translation_tasks", ["identity_sha256"]
    )
    op.create_index("ix_translation_tasks_status", "translation_tasks", ["status"])
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
    op.create_index("ix_translation_adoptions_result_id", "translation_adoptions", ["result_id"])
    op.create_index("ix_translation_adoptions_segment_id", "translation_adoptions", ["segment_id"])


def downgrade() -> None:
    op.drop_table("translation_adoptions")
    op.drop_table("translation_results")
    op.drop_table("translation_tasks")
    op.drop_table("translation_settings")
    op.drop_table("segment_context_settings")
    op.drop_table("segment_material_provenance")
    op.drop_table("chat_messages")
    op.drop_table("analysis_sections")
    op.drop_table("material_readings_current")
    op.drop_table("chat_jobs")
    op.drop_table("analysis_revisions")
    op.drop_table("reading_positions")
    op.drop_table("material_usage")
    op.drop_table("material_readings_generations")
    op.drop_table("material_custom_covers")
    op.drop_table("material_covers")
    op.drop_table("chat_threads")
    op.drop_table("chapter_reading_positions")
    op.drop_table("analyses")
    op.drop_table("segments")
    op.drop_table("provider_models")
    op.drop_table("materials")
    op.drop_table("sources")
    op.drop_table("settings_defaults")
    op.drop_table("runs")
    op.drop_table("providers")
    op.drop_table("learner_profile")
    op.drop_table("explanation_styles")
