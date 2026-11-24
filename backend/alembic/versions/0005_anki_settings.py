"""Add offline Anki connection settings and export configurations.

Revision ID: 0005_anki_settings
Revises: 0004_translation_reader_removal
"""

import sqlalchemy as sa

from alembic import op

revision = "0005_anki_settings"
down_revision = "0004_translation_reader_removal"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "anki_connection_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("url", sa.String(2048), nullable=False),
        sa.Column("credential_ref", sa.String(26)),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.CheckConstraint("id = 1", name="ck_anki_connection_singleton"),
        sa.CheckConstraint("revision >= 1", name="ck_anki_connection_revision"),
    )
    op.create_table(
        "anki_export_configurations",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("definition", sa.JSON(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("anki_export_configurations")
    op.drop_table("anki_connection_settings")
