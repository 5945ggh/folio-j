"""Durable conversation identities and accepted generation work."""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, DateTime, ForeignKey, Index, Integer, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class ChatThread(Base):
    __tablename__ = "chat_threads"
    __table_args__ = (
        Index("uq_chat_thread_create", "segment_id", "create_request_id", unique=True),
    )

    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    segment_id: Mapped[str] = mapped_column(ForeignKey("segments.id"), index=True)
    create_request_id: Mapped[str] = mapped_column(String(36))
    create_request_payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    selected_model_id: Mapped[str | None] = mapped_column(String(26))
    permission_mode: Mapped[str] = mapped_column(String(20))
    revision: Mapped[int] = mapped_column(Integer)
    active_job_id: Mapped[str | None] = mapped_column(String(26))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    __table_args__ = (
        Index("uq_chat_message_ordinal", "thread_id", "ordinal", unique=True),
        Index("uq_chat_message_job_role", "job_id", "role", unique=True),
    )

    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    thread_id: Mapped[str] = mapped_column(ForeignKey("chat_threads.id"), index=True)
    job_id: Mapped[str] = mapped_column(ForeignKey("chat_jobs.id"), index=True)
    ordinal: Mapped[int] = mapped_column(Integer)
    role: Mapped[str] = mapped_column(String(10))
    status: Mapped[str] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Job(Base):
    __tablename__ = "chat_jobs"
    __table_args__ = (
        Index("uq_chat_job_request", "thread_id", "request_id", unique=True),
        Index(
            "uq_chat_job_active",
            "thread_id",
            unique=True,
            sqlite_where=text("status IN ('queued','running','stopping') AND deleted_at IS NULL"),
        ),
    )

    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    kind: Mapped[str] = mapped_column(String(30))
    thread_id: Mapped[str] = mapped_column(ForeignKey("chat_threads.id"), index=True)
    request_id: Mapped[str] = mapped_column(String(36))
    request_payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(20), index=True)
    input_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON)
    model_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON)
    credential_ref: Mapped[str | None] = mapped_column(String(26))
    permission_mode: Mapped[str] = mapped_column(String(20))
    execution_token: Mapped[str | None] = mapped_column(String(26))
    error_code: Mapped[str | None] = mapped_column(String(40))
    error: Mapped[str | None] = mapped_column(Text)
    stop_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    version: Mapped[int] = mapped_column(Integer)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
