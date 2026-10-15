"""Version rebuildable cover caches without changing immutable materials."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0009_cover_rules"
down_revision: str | None = "0008_material_usage"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "material_covers",
        sa.Column("rule_version", sa.Integer(), nullable=False, server_default="1"),
    )
    op.add_column(
        "material_covers",
        sa.Column("diagnostic_reason", sa.Text(), nullable=False, server_default="legacy_cache"),
    )


def downgrade() -> None:
    with op.batch_alter_table("material_covers") as batch:
        batch.drop_column("diagnostic_reason")
        batch.drop_column("rule_version")
