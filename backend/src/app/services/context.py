"""Frozen chat input assembly; no database lookups in prompt rendering."""

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

from jinja2 import Environment, FileSystemLoader, StrictUndefined
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat_models import ChatMessage, Job
from app.models import Segment, Source
from app.settings_models import Profile, Style

PROMPTS = Path(__file__).resolve().parents[3] / "prompts" / "chat"
PROMPT_VERSION = "v4+tools_v4"
MAX_MESSAGE_CHARS = 200000
ENV = Environment(loader=FileSystemLoader(PROMPTS), undefined=StrictUndefined, autoescape=False)


def snapshot_time(value: datetime) -> str:
    timestamp = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    return timestamp.isoformat()


def convert_protocol_messages(
    messages: list[dict[str, Any]], source: str, target: str
) -> tuple[list[dict[str, Any]], int]:
    """Convert portable conversation facts when a user explicitly switches protocol."""
    if source == target:
        return messages, 0
    result: list[dict[str, Any]] = []
    omitted_reasoning = 0
    if source == "chat_completions":
        for item in messages:
            role = item.get("role")
            if role == "tool":
                result.append(
                    {
                        "type": "function_call_output",
                        "call_id": item["tool_call_id"],
                        "output": item.get("content") or "",
                    }
                )
            elif role == "assistant":
                if item.get("reasoning_content"):
                    omitted_reasoning += 1
                if item.get("content"):
                    result.append({"role": "assistant", "content": item["content"]})
                for call in item.get("tool_calls", []):
                    result.append(
                        {
                            "type": "function_call",
                            "call_id": call["id"],
                            "name": call["function"]["name"],
                            "arguments": call["function"]["arguments"],
                        }
                    )
            else:
                result.append(item)
        return result, omitted_reasoning
    pending: dict[str, Any] | None = None

    def flush() -> None:
        nonlocal pending
        if pending is not None:
            result.append(pending)
            pending = None

    for item in messages:
        kind = item.get("type")
        if kind == "reasoning":
            omitted_reasoning += 1
        elif kind == "function_call":
            if pending is None:
                pending = {"role": "assistant", "content": None}
            pending.setdefault("tool_calls", []).append(
                {
                    "id": item["call_id"],
                    "type": "function",
                    "function": {"name": item["name"], "arguments": item["arguments"]},
                }
            )
        elif kind == "function_call_output":
            flush()
            result.append(
                {
                    "role": "tool",
                    "tool_call_id": item["call_id"],
                    "content": item.get("output") or "",
                }
            )
        elif kind == "message":
            content = cast(list[dict[str, Any]], item.get("content", []))
            visible = "".join(
                str(value.get("text", ""))
                for value in content
                if value.get("type") in {"output_text", "text"}
            )
            if pending is None:
                pending = {"role": "assistant", "content": visible}
            else:
                pending["content"] = (pending.get("content") or "") + visible
        else:
            flush()
            result.append(item)
    flush()
    return result, omitted_reasoning


def _history_material(messages: list[dict[str, Any]]) -> str:
    portable: list[dict[str, Any]] = []
    for item in messages:
        if item.get("role") == "system" or item.get("type") == "reasoning":
            continue
        portable.append({key: value for key, value in item.items() if key != "reasoning_content"})
    return (
        ENV.get_template("history_material_v1.j2")
        .render(history_json=json.dumps(portable, ensure_ascii=False))
        .strip()
    )


async def make_input_snapshot(
    session: AsyncSession,
    thread_id: str,
    source: Source,
    segment: Segment,
    profile: Profile,
    style: Style | None,
    question: str,
    additional_instructions: str,
    protocol: str,
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
    system = ENV.get_template("system_v4.j2").render(**snapshot).strip()
    user = ENV.get_template("user_v2.j2").render(**snapshot).strip()
    previous = next(
        (
            job
            for _, job in reversed(history_rows)
            if job.execution_state and job.execution_state.get("protocol_messages")
        ),
        None,
    )
    messages: list[dict[str, Any]]
    if previous is not None:
        messages = list(previous.execution_state["protocol_messages"])
        prior_protocol = previous.model_snapshot["protocol"]
        if prior_protocol != protocol:
            omitted = sum(
                1
                for item in messages
                if item.get("type") == "reasoning" or item.get("reasoning_content")
            )
            messages = [
                {"role": "system", "content": system},
                {"role": "user", "content": _history_material(messages)},
            ]
            snapshot["protocol_conversion"] = {
                "from": prior_protocol,
                "to": protocol,
                "previous_job_id": previous.id,
                "provider_reasoning_items_not_portable": omitted,
                "strategy": "history_material_v1",
            }
    else:
        messages = [{"role": "system", "content": system}]
        legacy_items: list[dict[str, str]] = []
        for message, job in history_rows:
            if message.role == "user":
                prior_messages = job.input_snapshot.get("messages", [])
                previous_user = prior_messages[-1] if prior_messages else None
                content = message.content
                if isinstance(previous_user, dict):
                    prior_item = cast(dict[str, Any], previous_user)
                    if prior_item.get("role") == "user":
                        previous_content = prior_item.get("content")
                        if isinstance(previous_content, str):
                            content = previous_content
                legacy_items.append({"role": "user", "content": content})
            elif message.role == "assistant":
                legacy_items.append({"role": "assistant", "content": message.content})
        if legacy_items:
            messages.append({"role": "user", "content": _history_material(legacy_items)})
            snapshot["legacy_history_conversion"] = "history_material_v1"
    failed_jobs = (
        await session.scalars(
            select(Job)
            .where(
                Job.thread_id == thread_id,
                Job.deleted_at.is_(None),
                Job.status.in_(["failed", "interrupted"]),
            )
            .order_by(Job.created_at, Job.id)
        )
    ).all()
    recovered_artifacts: list[dict[str, str]] = []
    for failed in failed_jobs:
        if previous is not None and failed.created_at <= previous.created_at:
            continue
        for artifact in (failed.execution_state or {}).get("artifacts", []):
            if isinstance(artifact, dict):
                artifact_item = cast(dict[str, Any], artifact)
                analysis_id = artifact_item.get("analysis_id")
                revision_id = artifact_item.get("revision_id")
                if isinstance(analysis_id, str) and isinstance(revision_id, str):
                    recovered_artifacts.append(
                        {"analysis_id": analysis_id, "revision_id": revision_id}
                    )
    if recovered_artifacts:
        snapshot["recovered_artifacts"] = recovered_artifacts
        messages.append(
            {
                "role": "user",
                "content": ENV.get_template("recovered_artifacts_v1.j2")
                .render(artifacts_json=json.dumps(recovered_artifacts, ensure_ascii=False))
                .strip(),
            }
        )
    messages.append({"role": "user", "content": user})
    snapshot["messages"] = messages
    snapshot["tools"] = json.loads((PROMPTS / "tools_v4.json").read_text())["tools"]
    snapshot["writer_text"] = (
        Environment(
            loader=FileSystemLoader(PROMPTS.parent / "analysis"),
            undefined=StrictUndefined,
            autoescape=False,
        )
        .get_template("writer_v2.j2")
        .render()
        .strip()
    )
    snapshot["writer_version"] = "v2"
    snapshot["saved_artifact_template"] = (PROMPTS / "saved_artifact_v1.j2").read_text()
    snapshot["saved_artifact_version"] = "v1"
    snapshot["prompt_version"] = (
        PROMPT_VERSION
        + ("+artifact_v1" if recovered_artifacts else "")
        + (
            "+history_v1"
            if snapshot.get("protocol_conversion") or snapshot.get("legacy_history_conversion")
            else ""
        )
    )
    return snapshot
