"""Persistent learner preferences, model access and verification runs."""

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Profile(Base):
    __tablename__ = "learner_profile"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    native_language: Mapped[str] = mapped_column(String(100))
    explain_language: Mapped[str] = mapped_column(String(100))
    level_note: Mapped[str] = mapped_column(Text)


class Style(Base):
    __tablename__ = "explanation_styles"
    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    body_md: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Defaults(Base):
    __tablename__ = "settings_defaults"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    analysis_model_id: Mapped[str | None] = mapped_column(String(26))
    chat_model_id: Mapped[str | None] = mapped_column(String(26))
    extraction_model_id: Mapped[str | None] = mapped_column(String(26))
    style_id: Mapped[str | None] = mapped_column(String(26))
    permission_mode: Mapped[str] = mapped_column(String(20))


class Provider(Base):
    __tablename__ = "providers"
    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    base_url: Mapped[str] = mapped_column(String(2048))
    protocol: Mapped[str] = mapped_column(String(30))
    enabled: Mapped[bool] = mapped_column(Boolean)
    credential_ref: Mapped[str | None] = mapped_column(String(26))
    discovered_models: Mapped[list[str]] = mapped_column(JSON)
    discovery_status: Mapped[str] = mapped_column(String(20))
    discovery_error: Mapped[str | None] = mapped_column(Text)
    last_discovered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revision: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ProviderModel(Base):
    __tablename__ = "provider_models"
    __table_args__ = (Index("uq_provider_models_identity", "provider_id", "model_id", unique=True),)
    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    provider_id: Mapped[str] = mapped_column(ForeignKey("providers.id"), index=True)
    model_id: Mapped[str] = mapped_column(String(200))
    protocol_override: Mapped[str | None] = mapped_column(String(30))
    enabled: Mapped[bool] = mapped_column(Boolean)
    temperature: Mapped[float | None] = mapped_column(Float)
    max_output_tokens: Mapped[int | None] = mapped_column(Integer)
    reasoning_effort: Mapped[str | None] = mapped_column(String(10))
    revision: Mapped[int] = mapped_column(Integer)
    text_status: Mapped[str] = mapped_column(String(20))
    stream_status: Mapped[str] = mapped_column(String(20))


class Run(Base):
    __tablename__ = "runs"
    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    provider_id: Mapped[str] = mapped_column(String(26), index=True)
    provider_name: Mapped[str] = mapped_column(String(100))
    provider_revision: Mapped[int] = mapped_column(Integer)
    provider_model_id: Mapped[str] = mapped_column(String(26))
    model_revision: Mapped[int] = mapped_column(Integer)
    model_id: Mapped[str] = mapped_column(String(200))
    protocol: Mapped[str] = mapped_column(String(30))
    stream: Mapped[bool] = mapped_column(Boolean)
    status: Mapped[str] = mapped_column(String(20), index=True)
    output_text: Mapped[str] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    usage: Mapped[dict[str, int | None] | None] = mapped_column(JSON)
    prompt_version: Mapped[str] = mapped_column(String(20))
    prompt_text: Mapped[str] = mapped_column(Text)
    base_url: Mapped[str] = mapped_column(String(2048))
    credential_ref: Mapped[str | None] = mapped_column(String(26))
    temperature: Mapped[float | None] = mapped_column(Float)
    max_output_tokens: Mapped[int | None] = mapped_column(Integer)
    reasoning_effort: Mapped[str | None] = mapped_column(String(10))
    raw_response: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
