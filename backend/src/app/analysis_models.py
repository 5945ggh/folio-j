"""Persistent Analysis documents, immutable revisions and derived sections."""

from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Analysis(Base):
    __tablename__ = "analyses"
    __table_args__ = (UniqueConstraint("operation_key", name="uq_analysis_operation"),)

    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    segment_id: Mapped[str] = mapped_column(ForeignKey("segments.id"), nullable=False, index=True)
    operation_key: Mapped[str] = mapped_column(String(100), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    excerpt: Mapped[str] = mapped_column(String(240), nullable=False)
    current_revision_id: Mapped[str] = mapped_column(String(26), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AnalysisRevision(Base):
    __tablename__ = "analysis_revisions"
    __table_args__ = (UniqueConstraint("operation_key", name="uq_analysis_revision_operation"),)

    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    analysis_id: Mapped[str] = mapped_column(ForeignKey("analyses.id"), nullable=False, index=True)
    parent_revision_id: Mapped[str | None] = mapped_column(ForeignKey("analysis_revisions.id"))
    operation_key: Mapped[str] = mapped_column(String(100), nullable=False)
    operation_payload: Mapped[dict[str, object]] = mapped_column(JSON, nullable=False)
    origin: Mapped[str] = mapped_column(String(40), nullable=False)
    run_id: Mapped[str | None] = mapped_column(String(26))
    source_md: Mapped[str] = mapped_column(Text, nullable=False)
    normalizer_version: Mapped[int] = mapped_column(Integer, nullable=False)
    warnings: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Section(Base):
    __tablename__ = "analysis_sections"
    __table_args__ = (UniqueConstraint("revision_id", "uid", name="uq_section_revision_uid"),)

    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    revision_id: Mapped[str] = mapped_column(
        ForeignKey("analysis_revisions.id"), nullable=False, index=True
    )
    uid: Mapped[str] = mapped_column(String(26), nullable=False)
    handle: Mapped[str] = mapped_column(String(12), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    display_no: Mapped[str] = mapped_column(String(20), nullable=False)
    title: Mapped[str | None] = mapped_column(String(500))
    start_line: Mapped[int] = mapped_column(Integer, nullable=False)
    end_line: Mapped[int] = mapped_column(Integer, nullable=False)
    raw: Mapped[str] = mapped_column(Text, nullable=False)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
