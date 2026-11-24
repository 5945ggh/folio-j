"""Anki settings persist configuration only. Drafts have no database model."""

from typing import Any

from sqlalchemy import JSON, CheckConstraint, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class AnkiConnectionSettings(Base):
    __tablename__ = "anki_connection_settings"
    __table_args__ = (
        CheckConstraint("id = 1", name="ck_anki_connection_singleton"),
        CheckConstraint("revision >= 1", name="ck_anki_connection_revision"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    url: Mapped[str] = mapped_column(String(2048))
    credential_ref: Mapped[str | None] = mapped_column(String(26))
    revision: Mapped[int] = mapped_column(Integer)


class AnkiExportConfiguration(Base):
    __tablename__ = "anki_export_configurations"

    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    definition: Mapped[dict[str, Any]] = mapped_column(JSON)
