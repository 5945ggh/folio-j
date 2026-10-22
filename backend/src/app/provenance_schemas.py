"""Exact immutable material references, independent of reader position recovery."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_PROVENANCE_RANGES = 64
MAX_PROVENANCE_TEXT = 100000
MAX_PROVENANCE_CONTEXT = 64
MAX_PROVENANCE_MATCHES = 20
ASSEMBLY_RULE = "concat-nfc-v1"


class MaterialProvenanceRange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    resource_id: str = Field(min_length=1, max_length=100)
    spine_index: int = Field(ge=0, strict=True)
    start: int = Field(ge=0, strict=True)
    end: int = Field(gt=0, strict=True)
    exact: str = Field(min_length=1, max_length=MAX_PROVENANCE_TEXT)
    text_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    prefix: str = Field(default="", max_length=MAX_PROVENANCE_CONTEXT)
    suffix: str = Field(default="", max_length=MAX_PROVENANCE_CONTEXT)

    @model_validator(mode="after")
    def nonempty_range(self) -> "MaterialProvenanceRange":
        if self.end <= self.start:
            raise ValueError("范围须非空且按码点递增")
        return self


class MaterialProvenance(BaseModel):
    model_config = ConfigDict(extra="forbid")
    contract_version: Literal["1"]
    material_id: str = Field(min_length=1, max_length=26)
    version_id: str = Field(min_length=1, max_length=26)
    ranges: list[MaterialProvenanceRange] = Field(min_length=1, max_length=MAX_PROVENANCE_RANGES)

    @model_validator(mode="after")
    def bounded_snapshot(self) -> "MaterialProvenance":
        if sum(len(item.exact) for item in self.ranges) > MAX_PROVENANCE_TEXT:
            raise ValueError("目标原文超过出处快照限额")
        return self


class ProvenancePart(BaseModel):
    range_index: int
    part_index: int
    resource_id: str
    spine_index: int
    start: int
    end: int


def _empty_parts() -> list[ProvenancePart]:
    return []


class SegmentProvenanceResponse(BaseModel):
    segment_id: str
    material_provenance: MaterialProvenance | None
    display: str | None = None
    status: Literal[
        "resolved",
        "material_deleted",
        "version_unavailable",
        "snapshot_mismatch",
        "invalid_reference",
        "none",
    ]
    chapter_id: str | None = None
    parts: list[ProvenancePart] = Field(default_factory=_empty_parts)
    assembly_rule: str = ASSEMBLY_RULE
