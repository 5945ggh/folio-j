"""Retain deleted materials while allowing explicit reimport of their bytes.

Revision ID: 0003_material_soft_delete
Revises: 0002_lock_analysis_segments
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0003_material_soft_delete"
down_revision: str | None = "0002_lock_analysis_segments"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("materials", recreate="always") as batch:
        batch.add_column(sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
        batch.drop_constraint("uq_material_source_bytes", type_="unique")
        batch.create_index(
            "uq_material_source_bytes",
            ["source_id", "source_sha256"],
            unique=True,
            sqlite_where=sa.text("deleted_at IS NULL"),
        )


def downgrade() -> None:
    # The older schema cannot represent deletion, nor retain reimported copies.
    # Fail before touching data rather than silently restoring or deleting rows.
    if (
        op.get_bind()
        .execute(sa.text("SELECT 1 FROM materials WHERE deleted_at IS NOT NULL LIMIT 1"))
        .first()
        is not None
    ):
        raise RuntimeError("存在已删除材料，无法无损回退；请保留当前版本或从备份恢复")
    with op.batch_alter_table("materials", recreate="always") as batch:
        batch.drop_index("uq_material_source_bytes")
        batch.drop_column("deleted_at")
        batch.create_unique_constraint("uq_material_source_bytes", ["source_id", "source_sha256"])
