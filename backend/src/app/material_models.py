"""Immutable managed EPUB bundles and mutable reading positions."""

from datetime import datetime

from sqlalchemy import (
    JSON,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Material(Base):
    __tablename__ = "materials"
    __table_args__ = (
        UniqueConstraint("source_id", "source_sha256", name="uq_material_source_bytes"),
    )
    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    source_id: Mapped[str] = mapped_column(ForeignKey("sources.id"), nullable=False, index=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
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
