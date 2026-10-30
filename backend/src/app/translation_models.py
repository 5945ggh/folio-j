"""Translation values have their own identity, independent of discussion threads."""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class TranslationSettings(Base):
    __tablename__ = "translation_settings"
    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer)
    payload: Mapped[str] = mapped_column(Text)


class TranslationTask(Base):
    __tablename__ = "translation_tasks"
    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    request_id: Mapped[str] = mapped_column(String(36), unique=True)
    request_payload: Mapped[str] = mapped_column(Text)
    source_id: Mapped[str] = mapped_column(ForeignKey("sources.id"), index=True)
    material_id: Mapped[str] = mapped_column(ForeignKey("materials.id"), index=True)
    identity_sha256: Mapped[str] = mapped_column(String(64), index=True)
    payload: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), index=True)
    token: Mapped[str | None] = mapped_column(String(26))
    reader_deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    result_id: Mapped[str | None] = mapped_column(String(26))
    run_id: Mapped[str | None] = mapped_column(String(26))
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class TranslationResult(Base):
    __tablename__ = "translation_results"
    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    task_id: Mapped[str] = mapped_column(ForeignKey("translation_tasks.id"), unique=True)
    translation: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class TranslationAdoption(Base):
    __tablename__ = "translation_adoptions"
    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    request_id: Mapped[str] = mapped_column(String(36), unique=True)
    request_payload: Mapped[str] = mapped_column(Text)
    adopted_payload: Mapped[str] = mapped_column(Text)
    result_id: Mapped[str] = mapped_column(ForeignKey("translation_results.id"), index=True)
    segment_id: Mapped[str] = mapped_column(ForeignKey("segments.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
