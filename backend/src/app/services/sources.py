"""Source and Segment business operations."""

import asyncio
import hashlib
import unicodedata
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.analysis_models import Analysis
from app.chat_models import ChatMessage, ChatThread, Job
from app.ids import new_ulid
from app.material_models import Material
from app.models import Segment, Source
from app.schemas import (
    SegmentCreate,
    SegmentDeleteImpact,
    SegmentResponse,
    SegmentUpdate,
    SourceCreate,
    SourceDeleteImpact,
    SourceResponse,
    SourceUpdate,
)
from app.settings_models import Run


def utc_now() -> datetime:
    return datetime.now(UTC)


def as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def segment_text_sha256(text: str) -> str:
    return hashlib.sha256(unicodedata.normalize("NFC", text).encode()).hexdigest()


def lock_segment_text(segment: Segment, locked_at: datetime) -> None:
    """Protect text under the caller's transaction without changing the edit revision."""
    if segment.text_locked_at is None:
        segment.text_locked_at = locked_at


async def begin_write(session: AsyncSession) -> None:
    await session.execute(text("BEGIN IMMEDIATE"))


async def require_source(session: AsyncSession, source_id: str) -> Source:
    source = await session.scalar(
        select(Source).where(Source.id == source_id, Source.deleted_at.is_(None))
    )
    if source is None:
        raise HTTPException(status_code=404, detail="来源不存在")
    return source


async def require_segment(session: AsyncSession, segment_id: str) -> Segment:
    segment = await session.scalar(
        select(Segment)
        .join(Source, Segment.source_id == Source.id)
        .where(Segment.id == segment_id, Segment.deleted_at.is_(None), Source.deleted_at.is_(None))
    )
    if segment is None:
        raise HTTPException(status_code=404, detail="片段不存在")
    return segment


async def count_segments(session: AsyncSession, source_id: str) -> int:
    value = await session.scalar(
        select(func.count(Segment.id)).where(
            Segment.source_id == source_id, Segment.deleted_at.is_(None)
        )
    )
    return int(value or 0)


async def discussion_counts(session: AsyncSession, segment_ids: list[str]) -> tuple[int, int, int]:
    if not segment_ids:
        return 0, 0, 0
    thread_filter = (ChatThread.segment_id.in_(segment_ids), ChatThread.deleted_at.is_(None))
    threads = int(
        (await session.scalar(select(func.count(ChatThread.id)).where(*thread_filter))) or 0
    )
    messages = int(
        (
            await session.scalar(
                select(func.count(ChatMessage.id))
                .join(ChatThread, ChatMessage.thread_id == ChatThread.id)
                .where(*thread_filter, ChatMessage.deleted_at.is_(None))
            )
        )
        or 0
    )
    active = int(
        (
            await session.scalar(
                select(func.count(Job.id))
                .join(ChatThread, Job.thread_id == ChatThread.id)
                .where(
                    *thread_filter,
                    Job.deleted_at.is_(None),
                    Job.status.in_(["queued", "running", "waiting_review", "stopping"]),
                )
            )
        )
        or 0
    )
    return threads, messages, active


async def source_response(session: AsyncSession, source: Source) -> SourceResponse:
    return SourceResponse(
        id=source.id,
        title=source.title,
        description=source.description,
        note=source.note,
        created_at=as_utc(source.created_at),
        updated_at=as_utc(source.updated_at),
        segment_count=await count_segments(session, source.id),
    )


def segment_response(segment: Segment) -> SegmentResponse:
    return SegmentResponse(
        id=segment.id,
        source_id=segment.source_id,
        text=segment.text,
        text_sha256=segment_text_sha256(segment.text),
        translation=segment.translation,
        context_before=segment.context_before,
        context_after=segment.context_after,
        transcription=segment.transcription,
        note=segment.note,
        source_ref=segment.source_ref,
        created_at=as_utc(segment.created_at),
        updated_at=as_utc(segment.updated_at),
        text_locked_at=as_utc(segment.text_locked_at) if segment.text_locked_at else None,
        revision=segment.revision,
    )


async def list_sources(session: AsyncSession) -> list[SourceResponse]:
    sources = (
        await session.scalars(
            select(Source)
            .where(Source.deleted_at.is_(None))
            .order_by(Source.created_at.desc(), Source.id.desc())
        )
    ).all()
    return [await source_response(session, source) for source in sources]


async def create_source(session: AsyncSession, data: SourceCreate) -> SourceResponse:
    created = utc_now()
    source = Source(id=new_ulid(), created_at=created, updated_at=created, **data.model_dump())
    session.add(source)
    await session.commit()
    return await source_response(session, source)


async def get_source(session: AsyncSession, source_id: str) -> SourceResponse:
    return await source_response(session, await require_source(session, source_id))


async def update_source(
    session: AsyncSession, source_id: str, data: SourceUpdate
) -> SourceResponse:
    try:
        await begin_write(session)
        source = await require_source(session, source_id)
        changes = data.model_dump(exclude_unset=True)
        if any(getattr(source, key) != value for key, value in changes.items()):
            for key, value in changes.items():
                setattr(source, key, value)
            source.updated_at = utc_now()
        response = await source_response(session, source)
        await session.commit()
        return response
    except BaseException:
        await session.rollback()
        raise


async def source_delete_impact(session: AsyncSession, source_id: str) -> SourceDeleteImpact:
    source = await require_source(session, source_id)
    ids = list(
        (
            await session.scalars(
                select(Segment.id).where(
                    Segment.source_id == source_id, Segment.deleted_at.is_(None)
                )
            )
        ).all()
    )
    thread_count, message_count, active_job_count = await discussion_counts(session, ids)
    analysis_count = await analysis_count_for_segments(session, ids)
    return SourceDeleteImpact(
        source_id=source.id,
        title=source.title,
        material_count=int(
            (
                await session.scalar(
                    select(func.count(Material.id)).where(
                        Material.source_id == source_id, Material.deleted_at.is_(None)
                    )
                )
            )
            or 0
        ),
        segment_count=len(ids),
        thread_count=thread_count,
        message_count=message_count,
        active_job_count=active_job_count,
        analysis_count=analysis_count,
    )


async def segment_delete_impact(session: AsyncSession, segment_id: str) -> SegmentDeleteImpact:
    await require_segment(session, segment_id)
    thread_count, message_count, active_job_count = await discussion_counts(session, [segment_id])
    return SegmentDeleteImpact(
        segment_id=segment_id,
        thread_count=thread_count,
        message_count=message_count,
        active_job_count=active_job_count,
        analysis_count=await analysis_count_for_segments(session, [segment_id]),
    )


async def analysis_count_for_segments(session: AsyncSession, segment_ids: list[str]) -> int:
    if not segment_ids:
        return 0
    return int(
        await session.scalar(
            select(func.count(Analysis.id)).where(
                Analysis.segment_id.in_(segment_ids), Analysis.deleted_at.is_(None)
            )
        )
        or 0
    )


async def soft_delete_discussions(
    session: AsyncSession, segment_ids: list[str], deleted: datetime
) -> list[str]:
    if not segment_ids:
        return []
    thread_ids = list(
        (
            await session.scalars(
                select(ChatThread.id).where(
                    ChatThread.segment_id.in_(segment_ids), ChatThread.deleted_at.is_(None)
                )
            )
        ).all()
    )
    if not thread_ids:
        return []
    active_ids = list(
        (
            await session.scalars(
                select(Job.id).where(
                    Job.thread_id.in_(thread_ids),
                    Job.deleted_at.is_(None),
                    Job.status.in_(["queued", "running", "waiting_review", "stopping"]),
                )
            )
        ).all()
    )
    if active_ids:
        await session.execute(
            update(Job)
            .where(Job.id.in_(active_ids))
            .values(
                status="interrupted",
                execution_token=None,
                error_code="content_deleted",
                error="所属内容已删除",
                finished_at=deleted,
                version=Job.version + 1,
            )
        )
        await session.execute(
            update(Run)
            .where(Run.job_id.in_(active_ids), Run.status.in_(["queued", "running"]))
            .values(status="interrupted", error="所属内容已删除", finished_at=deleted)
        )
        await session.execute(
            update(ChatMessage)
            .where(ChatMessage.job_id.in_(active_ids), ChatMessage.role == "assistant")
            .values(status="interrupted", updated_at=deleted)
        )
    await session.execute(
        update(Job)
        .where(Job.thread_id.in_(thread_ids))
        .values(deleted_at=deleted, execution_token=None)
    )
    await session.execute(
        update(Run)
        .where(Run.job_id.in_(select(Job.id).where(Job.thread_id.in_(thread_ids))))
        .values(deleted_at=deleted)
    )
    await session.execute(
        update(ChatMessage).where(ChatMessage.thread_id.in_(thread_ids)).values(deleted_at=deleted)
    )
    await session.execute(
        update(ChatThread)
        .where(ChatThread.id.in_(thread_ids))
        .values(
            deleted_at=deleted,
            active_job_id=None,
            revision=ChatThread.revision + 1,
            updated_at=deleted,
        )
    )
    return active_ids


async def delete_source(
    session: AsyncSession, source_id: str, dispatch_lock: asyncio.Lock
) -> list[str]:
    async with dispatch_lock:
        return await _delete_source_committed(session, source_id)


async def _delete_source_committed(session: AsyncSession, source_id: str) -> list[str]:
    try:
        await begin_write(session)
        source = await require_source(session, source_id)
        deleted = utc_now()
        ids = list(
            (
                await session.scalars(
                    select(Segment.id).where(
                        Segment.source_id == source_id, Segment.deleted_at.is_(None)
                    )
                )
            ).all()
        )
        cancelled = await soft_delete_discussions(session, ids, deleted)
        from app.services.analyses import soft_delete_for_segments

        await soft_delete_for_segments(session, ids, deleted)
        source.deleted_at = deleted
        source.updated_at = deleted
        await session.execute(
            update(Segment)
            .where(Segment.source_id == source_id, Segment.deleted_at.is_(None))
            .values(deleted_at=deleted, updated_at=deleted)
        )
        await session.commit()
        return cancelled
    except BaseException:
        await session.rollback()
        raise


async def list_segments(session: AsyncSession, source_id: str) -> list[SegmentResponse]:
    await require_source(session, source_id)
    segments = (
        await session.scalars(
            select(Segment)
            .where(Segment.source_id == source_id, Segment.deleted_at.is_(None))
            .order_by(Segment.created_at.desc(), Segment.id.desc())
        )
    ).all()
    return [segment_response(segment) for segment in segments]


async def create_segment(
    session: AsyncSession, source_id: str, data: SegmentCreate
) -> SegmentResponse:
    try:
        await begin_write(session)
        await require_source(session, source_id)
        created = utc_now()
        segment = Segment(
            id=new_ulid(),
            source_id=source_id,
            created_at=created,
            updated_at=created,
            revision=1,
            **data.model_dump(),
        )
        session.add(segment)
        await session.commit()
        return segment_response(segment)
    except BaseException:
        await session.rollback()
        raise


async def get_segment(session: AsyncSession, segment_id: str) -> SegmentResponse:
    return segment_response(await require_segment(session, segment_id))


async def update_segment(
    session: AsyncSession, segment_id: str, data: SegmentUpdate
) -> SegmentResponse:
    try:
        await begin_write(session)
        segment = await require_segment(session, segment_id)
        changes = data.model_dump(exclude_unset=True)
        if (
            "text" in changes
            and segment.text_locked_at is not None
            and changes["text"] != segment.text
        ):
            raise HTTPException(status_code=409, detail="原文已锁定，不能修改")
        if any(getattr(segment, key) != value for key, value in changes.items()):
            for key, value in changes.items():
                setattr(segment, key, value)
            segment.updated_at = utc_now()
            segment.revision += 1
        response = segment_response(segment)
        await session.commit()
        return response
    except BaseException:
        await session.rollback()
        raise


async def delete_segment(
    session: AsyncSession, segment_id: str, dispatch_lock: asyncio.Lock
) -> list[str]:
    async with dispatch_lock:
        return await _delete_segment_committed(session, segment_id)


async def _delete_segment_committed(session: AsyncSession, segment_id: str) -> list[str]:
    try:
        await begin_write(session)
        segment = await require_segment(session, segment_id)
        deleted = utc_now()
        cancelled = await soft_delete_discussions(session, [segment_id], deleted)
        from app.services.analyses import soft_delete_for_segments

        await soft_delete_for_segments(session, [segment_id], deleted)
        segment.deleted_at = deleted
        segment.updated_at = deleted
        await session.commit()
        return cancelled
    except BaseException:
        await session.rollback()
        raise
