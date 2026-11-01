"""Discard managed reading assets while retaining material and learning identities."""

from datetime import datetime

from sqlalchemy import Select, delete, func, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.material_models import (
    ChapterReadingPosition,
    Material,
    MaterialCover,
    MaterialCustomCover,
    MaterialReadingsCurrent,
    MaterialReadingsGeneration,
    MaterialUsage,
    ReadingPosition,
)


async def clear_material_assets(
    session: AsyncSession, material_ids: Select[str], deleted: datetime
) -> None:
    """Mark materials deleted and clear their assets in the caller's write transaction."""
    await session.execute(
        update(Material)
        .where(Material.id.in_(material_ids))
        .values(
            deleted_at=func.coalesce(Material.deleted_at, deleted),
            original_bytes=b"",
            compiled_bundle=b"",
            warnings=[],
        )
    )
    # Include old tombstones with retained assets; remove pointers before generations.
    for asset in (
        ReadingPosition,
        ChapterReadingPosition,
        MaterialUsage,
        MaterialCover,
        MaterialCustomCover,
        MaterialReadingsCurrent,
        MaterialReadingsGeneration,
    ):
        await session.execute(delete(asset).where(asset.material_id.in_(material_ids)))
