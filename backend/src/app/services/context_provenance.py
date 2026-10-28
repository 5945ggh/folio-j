"""Prepare readable material provenance outside chat's acceptance transaction."""

from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.material_models import Material
from app.models import Segment, SegmentMaterialProvenance
from app.provenance_schemas import SegmentProvenanceResponse
from app.services import material_provenance


async def _basis(session: AsyncSession, segment_id: str) -> tuple[Any, ...]:
    row = (
        await session.execute(
            select(
                Segment.source_id,
                Segment.text,
                SegmentMaterialProvenance.source_id,
                SegmentMaterialProvenance.material_id,
                SegmentMaterialProvenance.version_id,
                SegmentMaterialProvenance.assembly_rule,
                SegmentMaterialProvenance.payload,
                Material.source_id,
                Material.version_id,
                Material.product_sha256,
                Material.contract_version,
                Material.metadata_revision,
                Material.title,
                Material.deleted_at,
                Material.compiled_bundle,
            )
            .select_from(Segment)
            .outerjoin(
                SegmentMaterialProvenance, SegmentMaterialProvenance.segment_id == Segment.id
            )
            .outerjoin(Material, Material.id == SegmentMaterialProvenance.material_id)
            .where(Segment.id == segment_id)
        )
    ).first()
    return tuple(row) if row is not None else ()


@dataclass(frozen=True)
class PreparedContextProvenance:
    value: SegmentProvenanceResponse
    basis: tuple[Any, ...]

    async def matches(self, session: AsyncSession, segment_id: str) -> bool:
        return self.value.segment_id == segment_id and self.basis == await _basis(
            session, segment_id
        )


async def prepare(session: AsyncSession, segment_id: str) -> PreparedContextProvenance | None:
    before = await _basis(session, segment_id)
    value = await material_provenance.resolve(session, segment_id)
    after = await _basis(session, segment_id)
    if before != after:
        return None
    return PreparedContextProvenance(value=value, basis=after)
