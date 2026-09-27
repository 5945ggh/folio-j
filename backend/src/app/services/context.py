"""Frozen chat input assembly; no database lookups in prompt rendering."""

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, StrictUndefined
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat_models import ChatMessage, Job
from app.models import Segment, Source
from app.settings_models import Profile, Style

PROMPTS = Path(__file__).resolve().parents[3] / "prompts" / "chat"
PROMPT_VERSION = "v2"
MAX_MESSAGE_CHARS = 200000
ENV = Environment(loader=FileSystemLoader(PROMPTS), undefined=StrictUndefined, autoescape=False)


def snapshot_time(value: datetime) -> str:
    timestamp = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    return timestamp.isoformat()


async def make_input_snapshot(
    session: AsyncSession,
    thread_id: str,
    source: Source,
    segment: Segment,
    profile: Profile,
    style: Style | None,
    question: str,
    additional_instructions: str,
) -> dict[str, Any]:
    history_rows = (
        await session.execute(
            select(ChatMessage, Job)
            .join(Job, ChatMessage.job_id == Job.id)
            .where(
                ChatMessage.thread_id == thread_id,
                ChatMessage.deleted_at.is_(None),
                Job.status == "succeeded",
                Job.deleted_at.is_(None),
            )
            .order_by(ChatMessage.ordinal)
        )
    ).all()
    history = [
        {
            "message_id": message.id,
            "job_id": job.id,
            "role": message.role,
            "content": message.content,
        }
        for message, job in history_rows
    ]
    snapshot: dict[str, Any] = {
        "snapshot_version": 1,
        "source": {
            "id": source.id,
            "title": source.title,
            "description": source.description,
            "updated_at": snapshot_time(source.updated_at),
        },
        "segment": {
            "id": segment.id,
            "source_id": segment.source_id,
            "revision": segment.revision,
            "text": segment.text,
            "translation": segment.translation,
            "context_before": segment.context_before,
            "context_after": segment.context_after,
            "transcription": segment.transcription,
            "source_ref": segment.source_ref,
        },
        "profile": {
            "native_language": profile.native_language,
            "explain_language": profile.explain_language,
            "level_note": profile.level_note,
        },
        "style": (
            {
                "id": style.id,
                "name": style.name,
                "body_md": style.body_md,
                "updated_at": snapshot_time(style.updated_at),
            }
            if style
            else None
        ),
        "question": question,
        "additional_instructions": additional_instructions,
        "history": history,
        "references": {
            "source_id": source.id,
            "segment_id": segment.id,
            "message_ids": [item["message_id"] for item in history],
        },
    }
    system = ENV.get_template("system_v2.j2").render(**snapshot).strip()
    user = ENV.get_template("user_v1.j2").render(**snapshot).strip()
    messages: list[dict[str, str]] = [{"role": "system", "content": system}]
    messages.extend({"role": item["role"], "content": item["content"]} for item in history)
    messages.append({"role": "user", "content": user})
    snapshot["messages"] = messages
    snapshot["prompt_version"] = PROMPT_VERSION
    return snapshot
