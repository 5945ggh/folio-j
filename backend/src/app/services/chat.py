"""Durable thread operations and atomic acceptance of one question."""

import asyncio
import base64
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, cast

from sqlalchemy import and_, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat_models import ChatMessage, ChatThread, Job
from app.chat_schemas import (
    JobCreate,
    JobDecision,
    JobResponse,
    MessagePage,
    MessageResponse,
    ModelSnapshotResponse,
    RunSummary,
    ThreadCreate,
    ThreadPage,
    ThreadPatch,
    ThreadResponse,
)
from app.ids import new_ulid
from app.models import Segment, Source
from app.services.context import MAX_MESSAGE_CHARS, make_input_snapshot
from app.services.settings import ensure_settings, read_credential, redact_credential
from app.services.sources import lock_segment_text
from app.settings_models import Defaults, Profile, Provider, ProviderModel, Run, Style


class ChatError(Exception):
    def __init__(self, status_code: int, detail: str, code: str) -> None:
        self.status_code = status_code
        self.detail = detail
        self.code = code
        super().__init__(detail)


def now() -> datetime:
    return datetime.now(UTC)


def utc(value: datetime | None) -> datetime | None:
    return value.replace(tzinfo=UTC) if value and value.tzinfo is None else value


async def begin_write(session: AsyncSession) -> None:
    await session.execute(text("BEGIN IMMEDIATE"))


async def require_segment(session: AsyncSession, segment_id: str) -> tuple[Source, Segment]:
    result = (
        await session.execute(
            select(Source, Segment)
            .join(Segment, Segment.source_id == Source.id)
            .where(
                Segment.id == segment_id,
                Segment.deleted_at.is_(None),
                Source.deleted_at.is_(None),
            )
        )
    ).first()
    if result is None:
        raise ChatError(404, "片段不存在", "not_found")
    return result


async def require_thread(session: AsyncSession, thread_id: str) -> ChatThread:
    thread = await session.scalar(
        select(ChatThread)
        .join(Segment, ChatThread.segment_id == Segment.id)
        .join(Source, Segment.source_id == Source.id)
        .where(
            ChatThread.id == thread_id,
            ChatThread.deleted_at.is_(None),
            Segment.deleted_at.is_(None),
            Source.deleted_at.is_(None),
        )
    )
    if thread is None:
        raise ChatError(404, "对话不存在", "not_found")
    return thread


async def require_job(session: AsyncSession, job_id: str) -> Job:
    job = await session.scalar(
        select(Job)
        .join(ChatThread, Job.thread_id == ChatThread.id)
        .join(Segment, ChatThread.segment_id == Segment.id)
        .join(Source, Segment.source_id == Source.id)
        .where(
            Job.id == job_id,
            Job.deleted_at.is_(None),
            ChatThread.deleted_at.is_(None),
            Segment.deleted_at.is_(None),
            Source.deleted_at.is_(None),
        )
    )
    if job is None:
        raise ChatError(404, "任务不存在", "not_found")
    return job


async def thread_response(session: AsyncSession, thread: ChatThread) -> ThreadResponse:
    first = await session.scalar(
        select(ChatMessage)
        .where(
            ChatMessage.thread_id == thread.id,
            ChatMessage.role == "user",
            ChatMessage.deleted_at.is_(None),
        )
        .order_by(ChatMessage.ordinal)
        .limit(1)
    )
    return ThreadResponse(
        id=thread.id,
        segment_id=thread.segment_id,
        display_title=(first.content[:40] if first else "新对话"),
        selected_model_id=thread.selected_model_id,
        permission_mode=cast(Literal["review", "full_access"], thread.permission_mode),
        revision=thread.revision,
        active_job_id=thread.active_job_id,
        created_at=cast(datetime, utc(thread.created_at)),
        updated_at=cast(datetime, utc(thread.updated_at)),
    )


def message_response(message: ChatMessage) -> MessageResponse:
    return MessageResponse(
        id=message.id,
        thread_id=message.thread_id,
        job_id=message.job_id,
        ordinal=message.ordinal,
        role=cast(Literal["user", "assistant"], message.role),
        status=cast(Any, message.status),
        content=message.content,
        created_at=cast(datetime, utc(message.created_at)),
        updated_at=cast(datetime, utc(message.updated_at)),
    )


async def job_response(session: AsyncSession, job: Job) -> JobResponse:
    assistant = await session.scalar(
        select(ChatMessage).where(
            ChatMessage.job_id == job.id,
            ChatMessage.role == "assistant",
            ChatMessage.deleted_at.is_(None),
        )
    )
    user = await session.scalar(
        select(ChatMessage).where(
            ChatMessage.job_id == job.id,
            ChatMessage.role == "user",
            ChatMessage.deleted_at.is_(None),
        )
    )
    runs = (
        await session.scalars(
            select(Run)
            .where(Run.job_id == job.id, Run.deleted_at.is_(None))
            .order_by(Run.created_at, Run.id)
        )
    ).all()
    run_id = runs[0].id if runs else None
    if assistant is None or user is None:
        raise ChatError(404, "任务不存在", "not_found")
    model = ModelSnapshotResponse.model_validate(
        {k: v for k, v in job.model_snapshot.items() if k in ModelSnapshotResponse.model_fields}
    )
    return JobResponse(
        id=job.id,
        thread_id=job.thread_id,
        request_id=job.request_id,
        status=cast(Any, job.status),
        version=job.version,
        user_message_id=user.id,
        assistant_message=message_response(assistant),
        run_id=run_id,
        kind="generate_analysis" if job.kind == "generate_analysis" else "chat",
        artifacts=(job.execution_state or {}).get("artifacts", []),
        active_step=cast(str | None, (job.execution_state or {}).get("active_step")),
        review_proposal=cast(Any, (job.execution_state or {}).get("review_proposal")),
        runs=[RunSummary(id=row.id, status=row.status, purpose=row.purpose) for row in runs],
        model=model,
        permission_mode=cast(Any, job.permission_mode),
        question=cast(str, job.input_snapshot["question"]),
        additional_instructions=cast(str, job.input_snapshot["additional_instructions"]),
        error_code=job.error_code,
        error=job.error,
        created_at=cast(datetime, utc(job.created_at)),
        started_at=utc(job.started_at),
        finished_at=utc(job.finished_at),
        stop_requested_at=utc(job.stop_requested_at),
    )


async def model_for_accept(
    session: AsyncSession, model_id: str | None
) -> tuple[ProviderModel, Provider]:
    if model_id is None:
        raise ChatError(409, "尚未选择可用模型", "model_unavailable")
    pair = (
        await session.execute(
            select(ProviderModel, Provider)
            .join(Provider, ProviderModel.provider_id == Provider.id)
            .where(
                ProviderModel.id == model_id,
                ProviderModel.enabled.is_(True),
                Provider.enabled.is_(True),
                Provider.deleted_at.is_(None),
            )
        )
    ).first()
    if pair is None:
        raise ChatError(409, "模型不可用", "model_unavailable")
    return pair


def explicit_payload(data: ThreadCreate | JobCreate) -> dict[str, Any]:
    if isinstance(data, ThreadCreate):
        return data.model_dump(exclude={"request_id"}, exclude_unset=True)
    return {
        "action": data.action,
        "expected_thread_revision": data.expected_thread_revision,
        "expected_segment_revision": data.expected_segment_revision,
        "question": data.question,
        "additional_instructions": data.additional_instructions,
        "model_id": data.model_id if "model_id" in data.model_fields_set else {"omitted": True},
        "style_id": data.style_id if "style_id" in data.model_fields_set else {"omitted": True},
        "stream": data.stream,
    }


async def create_thread(
    session: AsyncSession, segment_id: str, data: ThreadCreate
) -> ThreadResponse:
    await ensure_settings(session)
    try:
        await begin_write(session)
        await require_segment(session, segment_id)
        payload = explicit_payload(data)
        existing = await session.scalar(
            select(ChatThread).where(
                ChatThread.segment_id == segment_id, ChatThread.create_request_id == data.request_id
            )
        )
        if existing is not None:
            if existing.deleted_at is not None:
                raise ChatError(404, "对话不存在", "not_found")
            if existing.create_request_payload != payload:
                raise ChatError(409, "请求ID对应不同内容", "idempotency_conflict")
            response = await thread_response(session, existing)
            await session.commit()
            return response
        defaults = await session.get(Defaults, 1)
        assert defaults is not None
        explicit_model = "model_id" in data.model_fields_set and data.model_id is not None
        model_id = data.model_id if explicit_model else defaults.chat_model_id
        if explicit_model:
            await model_for_accept(session, model_id)
        created = now()
        thread = ChatThread(
            id=new_ulid(),
            segment_id=segment_id,
            create_request_id=data.request_id,
            create_request_payload=payload,
            selected_model_id=model_id,
            permission_mode=defaults.permission_mode,
            revision=1,
            active_job_id=None,
            created_at=created,
            updated_at=created,
            deleted_at=None,
        )
        session.add(thread)
        await session.flush()
        response = await thread_response(session, thread)
        await session.commit()
        return response
    except BaseException:
        await session.rollback()
        raise


async def get_thread(session: AsyncSession, thread_id: str) -> ThreadResponse:
    return await thread_response(session, await require_thread(session, thread_id))


async def patch_thread(session: AsyncSession, thread_id: str, data: ThreadPatch) -> ThreadResponse:
    try:
        await begin_write(session)
        thread = await require_thread(session, thread_id)
        if thread.active_job_id is not None:
            raise ChatError(409, "对话正在执行", "thread_busy")
        if thread.revision != data.expected_revision:
            raise ChatError(409, "对话版本已变化", "stale_thread")
        changes = data.model_dump(exclude_unset=True, exclude={"expected_revision"})
        if "model_id" in changes and changes["model_id"] is not None:
            await model_for_accept(session, changes["model_id"])
        if changes:
            for key, value in changes.items():
                setattr(thread, "selected_model_id" if key == "model_id" else key, value)
            thread.revision += 1
            thread.updated_at = now()
        response = await thread_response(session, thread)
        await session.commit()
        return response
    except BaseException:
        await session.rollback()
        raise


def encode_cursor(segment_id: str, thread: ChatThread) -> str:
    created_at = cast(datetime, utc(thread.created_at)).isoformat()
    raw = json.dumps([segment_id, created_at, thread.id], separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def decode_cursor(segment_id: str, cursor: str) -> tuple[datetime, str]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        decoded: object = json.loads(raw)
        if not isinstance(decoded, list):
            raise ValueError("cursor shape")
        parts = cast(list[object], decoded)
        if len(parts) != 3:
            raise ValueError("cursor shape")
        owner, date_value, identity = parts
        if owner != segment_id or not isinstance(date_value, str):
            raise ValueError("cursor ownership")
        timestamp = datetime.fromisoformat(date_value)
        if timestamp.tzinfo is None or not isinstance(identity, str) or len(identity) != 26:
            raise ValueError("cursor shape")
        return timestamp, identity
    except (ValueError, TypeError, KeyError, UnicodeError, json.JSONDecodeError) as exc:
        raise ChatError(422, "无效分页游标", "invalid_cursor") from exc


async def list_threads(
    session: AsyncSession, segment_id: str, limit: int, cursor: str | None
) -> ThreadPage:
    await require_segment(session, segment_id)
    query = select(ChatThread).where(
        ChatThread.segment_id == segment_id, ChatThread.deleted_at.is_(None)
    )
    if cursor is not None:
        timestamp, identity = decode_cursor(segment_id, cursor)
        query = query.where(
            or_(
                ChatThread.created_at < timestamp,
                and_(ChatThread.created_at == timestamp, ChatThread.id < identity),
            )
        )
    items = list(
        (
            await session.scalars(
                query.order_by(ChatThread.created_at.desc(), ChatThread.id.desc()).limit(limit + 1)
            )
        ).all()
    )
    has_more = len(items) > limit
    items = items[:limit]
    return ThreadPage(
        items=[await thread_response(session, item) for item in items],
        next_cursor=encode_cursor(segment_id, items[-1]) if has_more else None,
    )


async def list_messages(
    session: AsyncSession, thread_id: str, after_ordinal: int, limit: int
) -> MessagePage:
    await require_thread(session, thread_id)
    items = list(
        (
            await session.scalars(
                select(ChatMessage)
                .where(
                    ChatMessage.thread_id == thread_id,
                    ChatMessage.ordinal > after_ordinal,
                    ChatMessage.deleted_at.is_(None),
                )
                .order_by(ChatMessage.ordinal)
                .limit(limit + 1)
            )
        ).all()
    )
    has_more = len(items) > limit
    items = items[:limit]
    return MessagePage(
        items=[message_response(item) for item in items],
        next_cursor=items[-1].ordinal if has_more else None,
    )


async def accept_job(
    session: AsyncSession, thread_id: str, data: JobCreate, database_path: Path
) -> JobResponse:
    await ensure_settings(session)
    try:
        await begin_write(session)
        thread = await require_thread(session, thread_id)
        source, segment = await require_segment(session, thread.segment_id)
        payload = explicit_payload(data)
        old = await session.scalar(
            select(Job).where(Job.thread_id == thread_id, Job.request_id == data.request_id)
        )
        if old is not None:
            if old.deleted_at is not None:
                raise ChatError(404, "任务不存在", "not_found")
            if old.request_payload != payload:
                raise ChatError(409, "请求ID对应不同内容", "idempotency_conflict")
            response = await job_response(session, old)
            await session.commit()
            return response
        if thread.active_job_id is not None:
            raise ChatError(409, "对话正在执行", "thread_busy")
        if thread.revision != data.expected_thread_revision:
            raise ChatError(409, "对话版本已变化", "stale_thread")
        if segment.revision != data.expected_segment_revision:
            raise ChatError(409, "片段版本已变化", "stale_segment")
        model_id = data.model_id if data.model_id is not None else thread.selected_model_id
        model, provider = await model_for_accept(session, model_id)
        protocol = model.protocol_override or provider.protocol
        defaults = await session.get(Defaults, 1)
        profile = await session.get(Profile, 1)
        assert defaults is not None and profile is not None
        style_id = defaults.style_id if "style_id" not in data.model_fields_set else data.style_id
        style = await session.get(Style, style_id) if style_id else None
        if style_id is not None and style is None:
            raise ChatError(409, "讲解预设不可用", "style_unavailable")
        snapshot = await make_input_snapshot(
            session,
            thread_id,
            source,
            segment,
            profile,
            style,
            data.question,
            data.additional_instructions,
            protocol,
        )
        if len(json.dumps(snapshot["messages"], ensure_ascii=False)) > MAX_MESSAGE_CHARS:
            raise ChatError(422, "上下文超过本地上限，请缩短问题或新建对话", "context_limit")
        model_snapshot: dict[str, Any] = {
            "provider_id": provider.id,
            "provider_name": provider.name,
            "provider_revision": provider.revision,
            "base_url": provider.base_url,
            "provider_model_id": model.id,
            "model_id": model.model_id,
            "model_revision": model.revision,
            "protocol": protocol,
            "temperature": model.temperature,
            "max_output_tokens": model.max_output_tokens,
            "reasoning_effort": model.reasoning_effort,
            "stream": data.stream,
        }
        # A copied provider credential must never become durable input or an SDK message.
        # Missing credential files remain an execution-time failure after acceptance.
        try:
            credential = read_credential(database_path, provider.credential_ref)
        except (OSError, UnicodeError):
            credential = None
        if credential:
            serialized = json.dumps(
                {"request": payload, "input": snapshot, "model": model_snapshot},
                ensure_ascii=False,
                separators=(",", ":"),
            )
            if redact_credential(serialized, credential) != serialized:
                raise ChatError(422, "输入包含当前模型凭据，请移除后再发送", "credential_in_input")
        created = now()
        job = Job(
            id=new_ulid(),
            kind="generate_analysis" if data.action == "generate_analysis" else "chat_reply",
            thread_id=thread_id,
            request_id=data.request_id,
            request_payload=payload,
            status="queued",
            input_snapshot=snapshot,
            execution_state={"artifacts": [], "active_step": "queued", "review_proposal": None},
            model_snapshot=model_snapshot,
            credential_ref=provider.credential_ref,
            permission_mode=thread.permission_mode,
            execution_token=None,
            error_code=None,
            error=None,
            stop_requested_at=None,
            created_at=created,
            started_at=None,
            finished_at=None,
            version=1,
            deleted_at=None,
        )
        latest_ordinal = await session.scalar(
            select(func.max(ChatMessage.ordinal)).where(ChatMessage.thread_id == thread_id)
        )
        user = ChatMessage(
            id=new_ulid(),
            thread_id=thread_id,
            job_id=job.id,
            ordinal=int(latest_ordinal or 0) + 1,
            role="user",
            status="complete",
            content=data.question,
            created_at=created,
            updated_at=created,
            deleted_at=None,
        )
        assistant = ChatMessage(
            id=new_ulid(),
            thread_id=thread_id,
            job_id=job.id,
            ordinal=user.ordinal + 1,
            role="assistant",
            status="pending",
            content="",
            created_at=created,
            updated_at=created,
            deleted_at=None,
        )
        session.add(job)
        await session.flush()
        session.add_all([user, assistant])
        lock_segment_text(segment, created)
        thread.active_job_id = job.id
        thread.selected_model_id = model_id
        thread.revision += 1
        thread.updated_at = created
        await session.flush()
        response = await job_response(session, job)
        await session.commit()
        return response
    except BaseException:
        await session.rollback()
        raise


async def get_job(session: AsyncSession, job_id: str) -> JobResponse:
    return await job_response(session, await require_job(session, job_id))


async def get_job_by_request(session: AsyncSession, thread_id: str, request_id: str) -> JobResponse:
    await require_thread(session, thread_id)
    job = await session.scalar(
        select(Job).where(
            Job.thread_id == thread_id, Job.request_id == request_id, Job.deleted_at.is_(None)
        )
    )
    if job is None:
        raise ChatError(404, "任务不存在", "not_found")
    return await job_response(session, job)


async def stop_job(session: AsyncSession, job_id: str, dispatch_lock: asyncio.Lock) -> JobResponse:
    async with dispatch_lock:
        return await _stop_job_committed(session, job_id)


async def _stop_job_committed(session: AsyncSession, job_id: str) -> JobResponse:
    try:
        await begin_write(session)
        job = await require_job(session, job_id)
        thread = await require_thread(session, job.thread_id)
        if job.status in ("queued", "running", "waiting_review"):
            changed = now()
            job.stop_requested_at = changed
            job.execution_token = None
            job.version += 1
            thread.revision += 1
            thread.updated_at = changed
            if job.status in ("queued", "waiting_review"):
                job.status = "interrupted"
                job.error_code = "user_stopped"
                job.error = "用户已停止本轮"
                job.finished_at = changed
                if thread.active_job_id == job.id:
                    thread.active_job_id = None
                assistant = await session.scalar(
                    select(ChatMessage).where(
                        ChatMessage.job_id == job.id, ChatMessage.role == "assistant"
                    )
                )
                if assistant is not None:
                    assistant.status = "interrupted"
                    assistant.updated_at = changed
            else:
                job.status = "stopping"
        await session.flush()
        response = await job_response(session, job)
        await session.commit()
        return response
    except BaseException:
        await session.rollback()
        raise


async def decide_job(session: AsyncSession, job_id: str, data: JobDecision) -> JobResponse:
    """Resolve a persisted, version-bound proposal before work is resumed."""
    try:
        await begin_write(session)
        job = await require_job(session, job_id)
        state = dict(job.execution_state or {})
        request = {
            "expected_version": data.expected_version,
            "decision": data.decision,
            "additional_instructions": data.additional_instructions,
        }
        if request in state.get("decision_requests", []):
            response = await job_response(session, job)
            await session.commit()
            return response
        if state.get("decision_request") is not None:
            raise ChatError(409, "审核决定已提交", "decision_conflict")
        if job.status != "waiting_review" or job.version != data.expected_version:
            raise ChatError(409, "审核方案已经变化", "stale_review")
        proposal = state.get("review_proposal")
        if not isinstance(proposal, dict):
            raise ChatError(409, "没有待审核方案", "review_unavailable")
        state["decision"] = data.decision
        state["decision_instructions"] = data.additional_instructions
        state["decision_request"] = request
        state["decision_requests"] = [*state.get("decision_requests", []), request]
        state["active_step"] = (
            "applying_review" if data.decision == "approve" else "review_rejected"
        )
        job.execution_state = state
        job.status = "queued"
        job.version += 1
        response = await job_response(session, job)
        await session.commit()
        return response
    except BaseException:
        await session.rollback()
        raise
