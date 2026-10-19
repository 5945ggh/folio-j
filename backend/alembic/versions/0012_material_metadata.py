"""Keep editable display metadata separate from immutable EPUB products."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0012_material_metadata"
down_revision: str | None = "0011_chapter_positions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "materials",
        sa.Column("metadata_revision", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_table(
        "material_custom_covers",
        sa.Column("material_id", sa.String(26), sa.ForeignKey("materials.id"), primary_key=True),
        sa.Column("media_type", sa.String(40), nullable=False),
        sa.Column("data", sa.LargeBinary(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("material_custom_covers")
    # Native DROP COLUMN keeps incoming material foreign keys intact.
    op.drop_column("materials", "metadata_revision")
