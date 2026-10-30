"""Immutable managed EPUB bundles and mutable reading positions."""

from datetime import datetime

from sqlalchemy import (
    JSON,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Material(Base):
    __tablename__ = "materials"
    __table_args__ = (
        Index(
            "uq_material_source_bytes",
            "source_id",
            "source_sha256",
            unique=True,
            sqlite_where=text("deleted_at IS NULL"),
        ),
    )
    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    source_id: Mapped[str] = mapped_column(ForeignKey("sources.id"), nullable=False, index=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    title: Mapped[str] = mapped_column(Text, nullable=False)
    metadata_revision: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    source_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    version_id: Mapped[str] = mapped_column(String(26), nullable=False, unique=True)
    product_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    contract_version: Mapped[str] = mapped_column(String(64), nullable=False)
    original_bytes: Mapped[bytes] = mapped_column(LargeBinary, nullable=False, deferred=True)
    warnings: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    compiled_bundle: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class ReadingPosition(Base):
    __tablename__ = "reading_positions"
    material_id: Mapped[str] = mapped_column(ForeignKey("materials.id"), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    payload: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class ChapterReadingPosition(Base):
    """Last chapter anchor sharing the material position CAS revision."""

    __tablename__ = "chapter_reading_positions"
    material_id: Mapped[str] = mapped_column(ForeignKey("materials.id"), primary_key=True)
    chapter_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    payload: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class MaterialUsage(Base):
    """Mutable management state; its revision is independent of reading position."""

    __tablename__ = "material_usage"
    material_id: Mapped[str] = mapped_column(ForeignKey("materials.id"), primary_key=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    last_opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    last_action_id: Mapped[str | None] = mapped_column(String(100))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class MaterialCover(Base):
    """Rebuildable bounded raster cache; null data is a cached fallback."""

    __tablename__ = "material_covers"
    material_id: Mapped[str] = mapped_column(ForeignKey("materials.id"), primary_key=True)
    media_type: Mapped[str | None] = mapped_column(String(40))
    data: Mapped[bytes | None] = mapped_column(LargeBinary, deferred=True)
    rule_version: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    diagnostic_reason: Mapped[str] = mapped_column(Text, nullable=False, default="unexamined")


class MaterialCustomCover(Base):
    """User-owned cover override, independent of rebuildable extraction caches."""

    __tablename__ = "material_custom_covers"
    material_id: Mapped[str] = mapped_column(ForeignKey("materials.id"), primary_key=True)
    media_type: Mapped[str] = mapped_column(String(40), nullable=False)
    data: Mapped[bytes] = mapped_column(LargeBinary, nullable=False, deferred=True)


class MaterialReadingsGeneration(Base):
    """Validated immutable generations; older derived assets remain available."""

    __tablename__ = "material_readings_generations"
    __table_args__ = (
        UniqueConstraint("material_id", "version_id", "asset_sha256", name="uq_readings_asset"),
    )
    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    material_id: Mapped[str] = mapped_column(ForeignKey("materials.id"), nullable=False)
    version_id: Mapped[str] = mapped_column(String(26), nullable=False)
    asset_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    configuration: Mapped[str] = mapped_column(Text, nullable=False)
    token_count: Mapped[int] = mapped_column(Integer, nullable=False)
    payload: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class MaterialReadingsCurrent(Base):
    __tablename__ = "material_readings_current"
    material_id: Mapped[str] = mapped_column(ForeignKey("materials.id"), primary_key=True)
    generation_id: Mapped[str] = mapped_column(
        ForeignKey("material_readings_generations.id"), nullable=False
    )


class MaterialBookmark(Base):
    """Frozen position and excerpt with independently editable reading notes."""

    __tablename__ = "material_bookmarks"
    __table_args__ = (
        UniqueConstraint("material_id", "request_id", name="uq_material_bookmark_request"),
        Index(
            "ix_material_bookmark_order",
            "material_id",
            "version_id",
            "chapter_index",
            "part_index",
            "position_offset",
            "position_order",
            "image_progress",
            "id",
        ),
    )
    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    material_id: Mapped[str] = mapped_column(ForeignKey("materials.id"), nullable=False)
    version_id: Mapped[str] = mapped_column(String(26), nullable=False)
    request_id: Mapped[str] = mapped_column(String(36), nullable=False)
    request_payload: Mapped[str] = mapped_column(Text, nullable=False)
    position: Mapped[str] = mapped_column(Text, nullable=False)
    chapter_title: Mapped[str] = mapped_column(Text, nullable=False)
    excerpt: Mapped[str] = mapped_column(Text, nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False)
    chapter_index: Mapped[int] = mapped_column(Integer, nullable=False)
    part_index: Mapped[int] = mapped_column(Integer, nullable=False)
    position_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    position_order: Mapped[int] = mapped_column(Integer, nullable=False)
    image_progress: Mapped[float] = mapped_column(Float, nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
