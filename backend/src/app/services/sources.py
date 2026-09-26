"""Source and Segment business operations."""

from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.ids import new_ulid
from app.models import Segment, Source
from app.schemas import (
    SegmentCreate,
    SegmentResponse,
    SegmentUpdate,
    SourceCreate,
    SourceDeleteImpact,
    SourceResponse,
    SourceUpdate,
)


def utc_now() -> datetime:
    return datetime.now(UTC)


def as_utc(value: datetime) -> datetime:
    """SQLite returns naive datetimes; persisted timestamps are UTC."""
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


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
        .where(
            Segment.id == segment_id,
            Segment.deleted_at.is_(None),
            Source.deleted_at.is_(None),
        )
    )
    if segment is None:
        raise HTTPException(status_code=404, detail="片段不存在")
    return segment


async def count_segments(session: AsyncSession, source_id: str) -> int:
    count = await session.scalar(
        select(func.count(Segment.id)).where(
            Segment.source_id == source_id, Segment.deleted_at.is_(None)
        )
    )
    return int(count or 0)


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
        translation=segment.translation,
        context_before=segment.context_before,
        context_after=segment.context_after,
        transcription=segment.transcription,
        note=segment.note,
        source_ref=segment.source_ref,
        created_at=as_utc(segment.created_at),
        updated_at=as_utc(segment.updated_at),
        text_locked_at=as_utc(segment.text_locked_at) if segment.text_locked_at else None,
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
    now = utc_now()
    source = Source(id=new_ulid(), created_at=now, updated_at=now, **data.model_dump())
    session.add(source)
    await session.commit()
    return await source_response(session, source)


async def get_source(session: AsyncSession, source_id: str) -> SourceResponse:
    return await source_response(session, await require_source(session, source_id))


async def update_source(
    session: AsyncSession, source_id: str, data: SourceUpdate
) -> SourceResponse:
    source = await require_source(session, source_id)
    changes = data.model_dump(exclude_unset=True)
    if changes:
        for field, value in changes.items():
            setattr(source, field, value)
        source.updated_at = utc_now()
        await session.commit()
    return await source_response(session, source)


async def source_delete_impact(session: AsyncSession, source_id: str) -> SourceDeleteImpact:
    source = await require_source(session, source_id)
    return SourceDeleteImpact(
        source_id=source.id,
        title=source.title,
        segment_count=await count_segments(session, source.id),
    )


async def delete_source(session: AsyncSession, source_id: str) -> None:
    source = await require_source(session, source_id)
    now = utc_now()
    source.deleted_at = now
    source.updated_at = now
    await session.execute(
        update(Segment)
        .where(Segment.source_id == source_id, Segment.deleted_at.is_(None))
        .values(deleted_at=now, updated_at=now)
    )
    await session.commit()


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
    await require_source(session, source_id)
    now = utc_now()
    segment = Segment(
        id=new_ulid(), source_id=source_id, created_at=now, updated_at=now, **data.model_dump()
    )
    session.add(segment)
    await session.commit()
    return segment_response(segment)


async def get_segment(session: AsyncSession, segment_id: str) -> SegmentResponse:
    return segment_response(await require_segment(session, segment_id))


async def update_segment(
    session: AsyncSession, segment_id: str, data: SegmentUpdate
) -> SegmentResponse:
    segment = await require_segment(session, segment_id)
    changes = data.model_dump(exclude_unset=True)
    if "text" in changes and segment.text_locked_at is not None and changes["text"] != segment.text:
        raise HTTPException(status_code=409, detail="原文已锁定，不能修改")
    if changes:
        for field, value in changes.items():
            setattr(segment, field, value)
        segment.updated_at = utc_now()
        await session.commit()
    return segment_response(segment)


async def delete_segment(session: AsyncSession, segment_id: str) -> None:
    segment = await require_segment(session, segment_id)
    now = utc_now()
    segment.deleted_at = now
    segment.updated_at = now
    await session.commit()
