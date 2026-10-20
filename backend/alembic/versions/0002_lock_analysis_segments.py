"""Protect current source text wherever any historical Analysis already exists.

Revision ID: 0002_lock_analysis_segments
Revises: 0001_initial

The protection time is this migration's UTC execution time, not a reconstruction
of the text or acceptance time used by older explanations.
"""

import logging
from collections.abc import Sequence
from datetime import UTC, datetime

import sqlalchemy as sa

from alembic import op

revision: str = "0002_lock_analysis_segments"
down_revision: str | None = "0001_initial"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    statement = sa.text(
        """
        UPDATE segments
        SET text_locked_at = :protected_at
        WHERE text_locked_at IS NULL
          AND EXISTS (SELECT 1 FROM analyses WHERE analyses.segment_id = segments.id)
        """
    ).bindparams(sa.bindparam("protected_at", type_=sa.DateTime(timezone=True)))
    result = op.get_bind().execute(statement, {"protected_at": datetime.now(UTC)})
    logging.getLogger("alembic.runtime.migration").info(
        "已为 %s 个存在历史讲解的片段固定当前原文；保护时间为本次 UTC 执行时间，未补造原文历史。",
        result.rowcount,
    )


def downgrade() -> None:
    """Keep locks: later dependencies cannot be distinguished from this backfill."""
