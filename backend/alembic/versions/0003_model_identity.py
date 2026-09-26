"""Keep model registrations unique without rewriting existing identities.

Revision ID: 0003_model_identity
Revises: 0002_settings
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0003_model_identity"
down_revision: str | None = "0002_settings"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    duplicate = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT 1 FROM provider_models GROUP BY provider_id, model_id "
                "HAVING COUNT(*) > 1 LIMIT 1"
            )
        )
        .first()
    )
    if duplicate is not None:
        raise RuntimeError("存在重复模型登记；请先明确保留的模型身份，迁移不会自动合并或删除记录")
    op.create_index(
        "uq_provider_models_identity", "provider_models", ["provider_id", "model_id"], unique=True
    )


def downgrade() -> None:
    op.drop_index("uq_provider_models_identity", table_name="provider_models")
