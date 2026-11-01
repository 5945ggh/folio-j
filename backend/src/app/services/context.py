"""Frozen chat input assembly; no database lookups in prompt rendering."""

import json
from datetime import UTC, datetime
from typing import Any, cast

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat_models import ChatMessage, Job
from app.models import Segment, Source
from app.prompting import assemble_context
from app.provenance_schemas import SegmentProvenanceResponse
from app.services.context_plugins import CONTEXT_PLUGINS, ENV, PROMPTS
from app.settings_models import Profile, Style

PROMPT_VERSION = "v8+tools_v5+context_v1+user_v4"
MAX_MESSAGE_CHARS = 200000


def snapshot_time(value: datetime) -> str:
    timestamp = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    return timestamp.isoformat()


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
    protocol: str,
    *,
    material_provenance: SegmentProvenanceResponse | None = None,
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
        "snapshot_version": 4,
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
            "material_provenance": (
                {
                    "display": material_provenance.display,
                    "status": material_provenance.status,
                    "material_id": (
                        material_provenance.material_provenance.material_id
                        if material_provenance.material_provenance
                        else None
                    ),
                    "version_id": (
                        material_provenance.material_provenance.version_id
                        if material_provenance.material_provenance
                        else None
                    ),
                }
                if material_provenance is not None and material_provenance.status != "none"
                else None
            ),
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
        "history": history,
        "references": {
            "source_id": source.id,
            "segment_id": segment.id,
            "message_ids": [item["message_id"] for item in history],
        },
    }
    user = ENV.get_template("user_v4.j2").render(**snapshot).strip()
    previous = next(
        (
            job
            for _, job in reversed(history_rows)
            if job.execution_state and job.execution_state.get("protocol_messages")
        ),
        None,
    )
    same_protocol = previous is not None and previous.model_snapshot["protocol"] == protocol
    assembly = assemble_context(
        CONTEXT_PLUGINS,
        snapshot,
        previous.input_snapshot.get("context_state") if same_protocol and previous else None,
    )
    snapshot["context_state"] = assembly.state
    initial_system = [item for item in assembly.messages if item["role"] == "system"]
    initial_context = [item for item in assembly.messages if item["role"] != "system"]
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
                *initial_system,
                {"role": "user", "content": _history_material(messages)},
                *initial_context,
            ]
            snapshot["protocol_conversion"] = {
                "from": prior_protocol,
                "to": protocol,
                "previous_job_id": previous.id,
                "provider_reasoning_items_not_portable": omitted,
                "strategy": "history_material_v1",
            }
        else:
            messages.extend(assembly.messages)
    else:
        messages = list(initial_system)
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
        messages.extend(initial_context)
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
    snapshot["tools"] = json.loads((PROMPTS / "tools_v5.json").read_text(encoding="utf-8"))["tools"]
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
