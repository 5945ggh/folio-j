"""Analysis persistence and revision-safe editing.

Write functions only flush. Their caller owns BEGIN IMMEDIATE, job checks and commit.
"""

import unicodedata
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.analysis_models import Analysis, AnalysisRevision, Section
from app.analysis_schemas import (
    AnalysisDeleteImpact,
    AnalysisDetail,
    AnalysisListItem,
    SectionOperation,
    SectionRead,
)
from app.ids import new_ulid
from app.models import Segment, Source
from app.services.normalizer import NORMALIZER_VERSION, Block, normalize, split_source_lines
from app.services.sources import require_segment


def _now() -> datetime:
    return datetime.now(UTC)


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _excerpt(source: str) -> str:
    return " ".join(source.split())[:240]


def _title(source: str) -> str:
    doc = normalize(source)
    for block in doc.blocks:
        if block.kind == "section" and block.title:
            return block.title[:200]
    return _excerpt(source)[:200] or "未命名讲解"


def _item(analysis: Analysis) -> AnalysisListItem:
    return AnalysisListItem(
        id=analysis.id,
        segment_id=analysis.segment_id,
        title=analysis.title,
        excerpt=analysis.excerpt,
        current_revision_id=analysis.current_revision_id,
        created_at=_utc(analysis.created_at),
        updated_at=_utc(analysis.updated_at),
    )


async def _active_analysis(session: AsyncSession, analysis_id: str) -> Analysis:
    analysis = await session.scalar(
        select(Analysis)
        .join(Segment, Analysis.segment_id == Segment.id)
        .join(Source, Segment.source_id == Source.id)
        .where(
            Analysis.id == analysis_id,
            Analysis.deleted_at.is_(None),
            Segment.deleted_at.is_(None),
            Source.deleted_at.is_(None),
        )
    )
    if analysis is None:
        raise HTTPException(status_code=404, detail="讲解不存在")
    return analysis


async def _detail(session: AsyncSession, analysis: Analysis, revision_id: str) -> AnalysisDetail:
    revision = await session.scalar(
        select(AnalysisRevision).where(
            AnalysisRevision.id == revision_id, AnalysisRevision.analysis_id == analysis.id
        )
    )
    if revision is None:
        raise HTTPException(status_code=404, detail="修订不存在")
    sections = (
        await session.scalars(
            select(Section).where(Section.revision_id == revision.id).order_by(Section.ordinal)
        )
    ).all()
    return AnalysisDetail(
        **_item(analysis).model_dump(),
        revision_id=revision.id,
        parent_revision_id=revision.parent_revision_id,
        origin=revision.origin,
        run_id=revision.run_id,
        source_md=revision.source_md,
        normalizer_version=revision.normalizer_version,
        warnings=revision.warnings,
        sections=[
            SectionRead(
                id=section.id,
                uid=section.uid,
                handle=section.handle,
                kind=section.kind,
                display_no=section.display_no,
                title=section.title,
                raw=section.raw,
                start_line=section.start_line,
                end_line=section.end_line,
            )
            for section in sections
        ],
    )


async def list_analyses(
    session: AsyncSession, segment_id: str, *, limit: int = 50, offset: int = 0
) -> list[AnalysisListItem]:
    await require_segment(session, segment_id)
    if not 1 <= limit <= 100 or offset < 0:
        raise HTTPException(status_code=422, detail="分页参数无效")
    rows = (
        await session.scalars(
            select(Analysis)
            .where(Analysis.segment_id == segment_id, Analysis.deleted_at.is_(None))
            .order_by(Analysis.updated_at.desc(), Analysis.id.desc())
            .limit(limit)
            .offset(offset)
        )
    ).all()
    return [_item(row) for row in rows]


async def get_analysis(
    session: AsyncSession, analysis_id: str, revision_id: str | None = None
) -> AnalysisDetail:
    analysis = await _active_analysis(session, analysis_id)
    return await _detail(session, analysis, revision_id or analysis.current_revision_id)


def _handle(uid: str, existing: set[str]) -> str:
    for length in range(4, 7):
        candidate = "s_" + uid[-length:].lower()
        if candidate not in existing:
            existing.add(candidate)
            return candidate
    raise ValueError("handle collision")


async def _save_revision(
    session: AsyncSession,
    analysis: Analysis,
    *,
    source_md: str,
    parent_revision_id: str | None,
    operation_key: str,
    operation_payload: dict[str, object],
    origin: str,
    run_id: str | None,
    identity: list[tuple[str, str] | None] | None = None,
) -> AnalysisDetail:
    doc = normalize(source_md)
    if identity is not None and len(identity) != len(doc.blocks):
        raise HTTPException(status_code=422, detail="编辑后的块边界与方案不一致")
    revision_id = new_ulid()
    created = _now()
    session.add(
        AnalysisRevision(
            id=revision_id,
            analysis_id=analysis.id,
            parent_revision_id=parent_revision_id,
            operation_key=operation_key,
            operation_payload=operation_payload,
            origin=origin,
            run_id=run_id,
            source_md=source_md,
            normalizer_version=NORMALIZER_VERSION,
            warnings=list(doc.warnings),
            created_at=created,
        )
    )
    used = {entry[1] for entry in identity or [] if entry is not None}
    for ordinal, block in enumerate(doc.blocks):
        known = identity[ordinal] if identity is not None else None
        uid = known[0] if known is not None else new_ulid()
        if known is not None:
            handle = known[1]
        else:
            while True:
                try:
                    handle = _handle(uid, used)
                    break
                except ValueError:
                    uid = new_ulid()
        session.add(
            Section(
                id=new_ulid(),
                revision_id=revision_id,
                uid=uid,
                handle=handle,
                kind=block.kind,
                display_no=block.display_no,
                title=block.title,
                start_line=block.start_line,
                end_line=block.end_line,
                raw=block.raw,
                ordinal=ordinal,
            )
        )
    analysis.current_revision_id = revision_id
    analysis.excerpt = _excerpt(source_md)
    analysis.updated_at = created
    await session.flush()
    return await _detail(session, analysis, revision_id)


async def create_analysis(
    session: AsyncSession,
    *,
    segment_id: str,
    source_md: str,
    operation_key: str,
    origin: str,
    run_id: str | None = None,
    title: str | None = None,
) -> AnalysisDetail:
    """Create once under the caller's write transaction; no implicit commit."""
    if not operation_key or len(operation_key) > 100:
        raise HTTPException(status_code=422, detail="无效操作身份")
    source_md = unicodedata.normalize("NFC", source_md)
    create_payload: dict[str, object] = {
        "segment_id": segment_id,
        "origin": origin,
        "run_id": run_id,
        "title": title,
    }
    existing = await session.scalar(select(Analysis).where(Analysis.operation_key == operation_key))
    if existing is not None:
        if existing.segment_id != segment_id or existing.deleted_at is not None:
            raise HTTPException(status_code=409, detail="操作身份已用于其他讲解")
        original = await session.scalar(
            select(AnalysisRevision).where(
                AnalysisRevision.analysis_id == existing.id,
                AnalysisRevision.parent_revision_id.is_(None),
            )
        )
        if (
            original is None
            or original.operation_payload != create_payload
            or original.source_md != source_md
        ):
            raise HTTPException(status_code=409, detail="操作身份对应的请求不同")
        return await _detail(session, existing, original.id)
    await require_segment(session, segment_id)
    if not source_md.strip() or len(source_md) > 500_000:
        raise HTTPException(status_code=422, detail="讲解正文须非空且不超过 500000 字符")
    created = _now()
    analysis = Analysis(
        id=new_ulid(),
        segment_id=segment_id,
        operation_key=operation_key,
        title=(title.strip()[:200] if title and title.strip() else _title(source_md)),
        excerpt=_excerpt(source_md),
        current_revision_id="",
        created_at=created,
        updated_at=created,
    )
    session.add(analysis)
    await session.flush()
    result = await _save_revision(
        session,
        analysis,
        source_md=source_md,
        parent_revision_id=None,
        operation_key=operation_key,
        operation_payload=create_payload,
        origin=origin,
        run_id=run_id,
    )
    if title and title.strip():
        analysis.title = title.strip()[:200]
        result.title = analysis.title
    return result


def _section_raw(title: str, body: str) -> str:
    title = unicodedata.normalize("NFC", title.strip())
    body = unicodedata.normalize("NFC", body)
    if not title or "\n" in title or "\r" in title or len(title) > 500:
        raise HTTPException(status_code=422, detail="块标题无效")
    raw = f"## {title}\n"
    if body:
        raw += "\n" + body.lstrip("\r\n")
        if not raw.endswith(("\n", "\r")):
            raw += "\n"
    if len([block for block in normalize(raw).blocks if block.kind == "section"]) != 1:
        raise HTTPException(status_code=422, detail="一个块只能包含一个二级标题")
    return raw


def preview_section_replacement(block: Block, title: str | None, body: str | None) -> str:
    """Render the exact Section Markdown used by a reviewed update."""
    lines = split_source_lines(block.raw)
    heading_lines = block.heading_lines
    setext = heading_lines > 1
    heading = "".join(lines[:heading_lines])
    if title is not None:
        normalized_title = unicodedata.normalize("NFC", title.strip())
        if (
            not normalized_title
            or len(normalized_title) > 500
            or "\n" in normalized_title
            or "\r" in normalized_title
        ):
            raise HTTPException(status_code=422, detail="块标题无效")
        first = lines[0]
        ending = (
            "\r\n"
            if first.endswith("\r\n")
            else "\n"
            if first.endswith("\n")
            else "\r"
            if first.endswith("\r")
            else ""
        )
        heading = (
            normalized_title + ending + lines[heading_lines - 1]
            if setext
            else f"## {normalized_title}" + ending
        )
    tail = "".join(lines[heading_lines:]) if body is None else unicodedata.normalize("NFC", body)
    if body is not None and tail and not heading.endswith(("\n", "\r")):
        heading += "\n"
    result = heading + tail
    if len([part for part in normalize(result).blocks if part.kind == "section"]) != 1:
        raise HTTPException(status_code=422, detail="一个块只能包含一个二级标题")
    return result


def join_revision_blocks(blocks: list[str]) -> str:
    """Keep a line boundary before each following Section without rewriting block bodies."""
    pieces = [
        raw + "\n" if index < len(blocks) - 1 and raw and not raw.endswith(("\n", "\r")) else raw
        for index, raw in enumerate(blocks)
    ]
    return "".join(pieces)


async def apply_operation(
    session: AsyncSession,
    *,
    segment_id: str,
    analysis_id: str,
    base_revision_id: str,
    operation_key: str,
    operation: SectionOperation,
    run_id: str | None = None,
) -> AnalysisDetail:
    """Apply a reviewed edit, preserving old revisions and explicit block identity."""
    if not operation_key or len(operation_key) > 100:
        raise HTTPException(status_code=422, detail="无效操作身份")
    operation_payload: dict[str, object] = {
        "operation": operation.model_dump(mode="json"),
        "run_id": run_id,
    }
    prior = await session.scalar(
        select(AnalysisRevision).where(AnalysisRevision.operation_key == operation_key)
    )
    if prior is not None:
        if (
            prior.analysis_id != analysis_id
            or prior.parent_revision_id != base_revision_id
            or prior.operation_payload != operation_payload
        ):
            raise HTTPException(status_code=409, detail="操作身份已用于其他讲解")
        analysis = await _active_analysis(session, analysis_id)
        if analysis.segment_id != segment_id:
            raise HTTPException(status_code=404, detail="讲解不属于当前片段")
        return await _detail(session, analysis, prior.id)
    analysis = await _active_analysis(session, analysis_id)
    if analysis.segment_id != segment_id:
        raise HTTPException(status_code=404, detail="讲解不属于当前片段")
    if analysis.current_revision_id != base_revision_id:
        raise HTTPException(status_code=409, detail="讲解版本已变化")
    current = await _detail(session, analysis, base_revision_id)
    blocks = list(normalize(current.source_md).blocks)
    identity: list[tuple[str, str] | None] = [(row.uid, row.handle) for row in current.sections]
    if len(blocks) != len(identity):
        raise HTTPException(status_code=409, detail="修订结构不一致")
    raw = [block.raw for block in blocks]
    by_uid = {section.uid: index for index, section in enumerate(current.sections)}
    sid = operation.sid
    if operation.kind == "update_preamble":
        if operation.body is None:
            raise HTTPException(status_code=422, detail="缺少总述正文")
        preamble = unicodedata.normalize("NFC", operation.body)
        if any(block.kind == "section" for block in normalize(preamble).blocks):
            raise HTTPException(status_code=422, detail="总述不能包含二级标题")
        raw[0] = preamble + ("\n" if preamble and not preamble.endswith(("\n", "\r")) else "")
    elif operation.kind == "insert_sections":
        if not operation.sections:
            raise HTTPException(status_code=422, detail="至少插入一个块")
        index = 1 if operation.after_sid is None else by_uid.get(operation.after_sid, -1) + 1
        if index <= 0:
            raise HTTPException(status_code=404, detail="插入锚点不存在")
        if index == 1 and raw[0] and not raw[0].endswith(("\n", "\r")):
            raw[0] += "\n"
        if index > 1 and raw[index - 1] and not raw[index - 1].endswith(("\n", "\r")):
            raw[index - 1] += "\n"
        for offset, entry in enumerate(operation.sections):
            raw.insert(index + offset, _section_raw(entry.title, entry.body))
            identity.insert(index + offset, None)
    else:
        index = by_uid.get(sid or "", -1)
        if index <= 0:
            raise HTTPException(status_code=404, detail="目标块不存在")
        if operation.kind == "delete_section":
            del raw[index]
            del identity[index]
        else:
            block = blocks[index]
            if operation.title is None and operation.body is None:
                raise HTTPException(status_code=422, detail="没有修改内容")
            raw[index] = preview_section_replacement(block, operation.title, operation.body)
    source = join_revision_blocks(raw)
    if len(source) > 500_000:
        raise HTTPException(status_code=422, detail="讲解正文超过 500000 字符")
    return await _save_revision(
        session,
        analysis,
        source_md=source,
        parent_revision_id=base_revision_id,
        operation_key=operation_key,
        operation_payload=operation_payload,
        origin="section_edit",
        run_id=run_id,
        identity=identity,
    )


async def delete_impact(session: AsyncSession, analysis_id: str) -> AnalysisDeleteImpact:
    analysis = await _active_analysis(session, analysis_id)
    revision_count = int(
        await session.scalar(
            select(func.count(AnalysisRevision.id)).where(
                AnalysisRevision.analysis_id == analysis_id
            )
        )
        or 0
    )
    section_count = int(
        await session.scalar(
            select(func.count(Section.id))
            .join(AnalysisRevision, Section.revision_id == AnalysisRevision.id)
            .where(AnalysisRevision.analysis_id == analysis_id)
        )
        or 0
    )
    return AnalysisDeleteImpact(
        analysis_id=analysis_id,
        title=analysis.title,
        revision_count=revision_count,
        section_count=section_count,
    )


async def soft_delete_for_segments(
    session: AsyncSession, segment_ids: list[str], deleted: datetime
) -> None:
    if segment_ids:
        await session.execute(
            update(Analysis)
            .where(Analysis.segment_id.in_(segment_ids), Analysis.deleted_at.is_(None))
            .values(deleted_at=deleted, updated_at=deleted)
        )


async def delete_analysis(session: AsyncSession, analysis_id: str) -> None:
    from app.services.sources import begin_write

    try:
        await begin_write(session)
        analysis = await _active_analysis(session, analysis_id)
        deleted = _now()
        analysis.deleted_at = deleted
        analysis.updated_at = deleted
        await session.commit()
    except BaseException:
        await session.rollback()
        raise
