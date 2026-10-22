"""Persistent Source and Segment records."""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class Source(Base):
    __tablename__ = "sources"

    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    note: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    segments: Mapped[list["Segment"]] = relationship(back_populates="source")


class Segment(Base):
    __tablename__ = "segments"

    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    source_id: Mapped[str] = mapped_column(ForeignKey("sources.id"), nullable=False, index=True)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    translation: Mapped[str] = mapped_column(Text, nullable=False, default="")
    context_before: Mapped[str] = mapped_column(Text, nullable=False, default="")
    context_after: Mapped[str] = mapped_column(Text, nullable=False, default="")
    transcription: Mapped[str] = mapped_column(Text, nullable=False, default="")
    note: Mapped[str] = mapped_column(Text, nullable=False, default="")
    source_ref: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    text_locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    source: Mapped[Source] = relationship(back_populates="segments")
    material_provenance: Mapped["SegmentMaterialProvenance | None"] = relationship(
        lazy="joined", uselist=False
    )


class SegmentMaterialProvenance(Base):
    """One immutable origin and creation receipt per material-backed Segment."""

    __tablename__ = "segment_material_provenance"
    __table_args__ = (
        UniqueConstraint("source_id", "request_id", name="uq_segment_provenance_request"),
    )
    segment_id: Mapped[str] = mapped_column(ForeignKey("segments.id"), primary_key=True)
    source_id: Mapped[str] = mapped_column(ForeignKey("sources.id"), nullable=False)
    material_id: Mapped[str] = mapped_column(ForeignKey("materials.id"), nullable=False)
    version_id: Mapped[str] = mapped_column(String(26), nullable=False)
    payload: Mapped[str] = mapped_column(Text, nullable=False)
    identity_sha256: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    request_id: Mapped[str] = mapped_column(String(36), nullable=False)
    request_payload: Mapped[str] = mapped_column(Text, nullable=False)
    assembly_rule: Mapped[str] = mapped_column(String(40), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
