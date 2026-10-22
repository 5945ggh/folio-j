"""Lean, server-filtered catalogs. Titles use SQLite BINARY Unicode codepoint order."""

from typing import Literal, cast

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from app.analysis_models import Analysis
from app.catalog_schemas import (
    AnalysisCatalogItem,
    AnalysisCatalogPage,
    MaterialCatalogItem,
    MaterialCatalogPage,
    ReadingStatus,
    SegmentCatalogPage,
    SourceCatalogItem,
    SourceCatalogPage,
)
from app.material_models import Material, MaterialCover, MaterialCustomCover, MaterialUsage
from app.models import Segment, Source
from app.services.covers import cover_url
from app.services.materials import summary
from app.services.sources import as_utc, require_source, segment_response

Order = Literal["asc", "desc"]


def literal_search(value: str) -> str:
    return "%" + value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


async def material_catalog(
    session: AsyncSession,
    source_id: str | None,
    q: str,
    status: ReadingStatus | None,
    sort: Literal["title", "created_at", "last_opened_at"],
    order: Order,
    page: int,
    page_size: int,
) -> MaterialCatalogPage:
    if source_id:
        await require_source(session, source_id)
    statement = (
        select(
            Material,
            Source.title,
            MaterialUsage.status,
            MaterialUsage.revision,
            MaterialUsage.last_opened_at,
            MaterialCover.material_id,
            MaterialCover.media_type,
            MaterialCover.rule_version,
            MaterialCustomCover.material_id,
        )
        .join(Source, Material.source_id == Source.id)
        .outerjoin(MaterialUsage, MaterialUsage.material_id == Material.id)
        .outerjoin(MaterialCover, MaterialCover.material_id == Material.id)
        .outerjoin(MaterialCustomCover, MaterialCustomCover.material_id == Material.id)
        .options(defer(Material.compiled_bundle))
        .where(Source.deleted_at.is_(None), Material.deleted_at.is_(None))
    )
    if source_id:
        statement = statement.where(Material.source_id == source_id)
    if q:
        pattern = literal_search(q)
        statement = statement.where(
            or_(Material.title.like(pattern, escape="\\"), Source.title.like(pattern, escape="\\"))
        )
    if status:
        statement = statement.where(func.coalesce(MaterialUsage.status, "not_started") == status)
    count = int(await session.scalar(select(func.count()).select_from(statement.subquery())) or 0)
    key = {
        "title": Material.title.collate("BINARY"),
        "created_at": Material.created_at,
        "last_opened_at": MaterialUsage.last_opened_at,
    }[sort]
    if sort == "last_opened_at":
        statement = statement.order_by(MaterialUsage.last_opened_at.is_(None))
    statement = (
        statement.order_by(key.asc() if order == "asc" else key.desc(), Material.id.asc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    items: list[MaterialCatalogItem] = []
    for (
        material,
        source_title,
        usage_status,
        revision,
        opened,
        cover_id,
        media_type,
        cover_version,
        custom_id,
    ) in (await session.execute(statement)).all():
        items.append(
            MaterialCatalogItem(
                **summary(material).model_dump(),
                source_title=source_title,
                cover_url=cover_url(
                    material,
                    custom=cast(str | None, custom_id) is not None,
                    cache_id=cover_id,
                    media_type=media_type,
                    rule_version=cover_version,
                ),
                status=cast(ReadingStatus, usage_status or "not_started"),
                usage_revision=revision or 0,
                last_opened_at=as_utc(opened) if opened else None,
            )
        )
    return MaterialCatalogPage(items=items, total=count, page=page, page_size=page_size)


async def source_catalog(
    session: AsyncSession,
    q: str,
    sort: Literal["title", "created_at", "updated_at"],
    order: Order,
    page: int,
    page_size: int,
) -> SourceCatalogPage:
    statement = select(Source).where(Source.deleted_at.is_(None))
    if q:
        statement = statement.where(Source.title.like(literal_search(q), escape="\\"))
    count = int(await session.scalar(select(func.count()).select_from(statement.subquery())) or 0)
    key = {
        "title": Source.title.collate("BINARY"),
        "created_at": Source.created_at,
        "updated_at": Source.updated_at,
    }[sort]
    rows = (
        await session.scalars(
            statement.order_by(key.asc() if order == "asc" else key.desc(), Source.id.asc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).all()
    ids = [source.id for source in rows]
    materials = dict(
        (
            await session.execute(
                select(Material.source_id, func.count())
                .where(Material.source_id.in_(ids), Material.deleted_at.is_(None))
                .group_by(Material.source_id)
            )
        ).all()
    )
    segments = dict(
        (
            await session.execute(
                select(Segment.source_id, func.count())
                .where(Segment.source_id.in_(ids), Segment.deleted_at.is_(None))
                .group_by(Segment.source_id)
            )
        ).all()
    )
    analyses = dict(
        (
            await session.execute(
                select(Segment.source_id, func.count())
                .join(Analysis, Analysis.segment_id == Segment.id)
                .where(
                    Segment.source_id.in_(ids),
                    Segment.deleted_at.is_(None),
                    Analysis.deleted_at.is_(None),
                )
                .group_by(Segment.source_id)
            )
        ).all()
    )
    return SourceCatalogPage(
        items=[
            SourceCatalogItem(
                id=s.id,
                title=s.title,
                description=s.description,
                note=s.note,
                created_at=as_utc(s.created_at),
                updated_at=as_utc(s.updated_at),
                segment_count=segments.get(s.id, 0),
                material_count=materials.get(s.id, 0),
                analysis_count=analyses.get(s.id, 0),
            )
            for s in rows
        ],
        total=count,
        page=page,
        page_size=page_size,
    )


async def segment_catalog(
    session: AsyncSession,
    source_id: str,
    q: str,
    sort: Literal["created_at", "updated_at"],
    order: Order,
    page: int,
    page_size: int,
) -> SegmentCatalogPage:
    await require_source(session, source_id)
    statement = select(Segment).where(Segment.source_id == source_id, Segment.deleted_at.is_(None))
    if q:
        pattern = literal_search(q)
        statement = statement.where(
            or_(
                Segment.text.like(pattern, escape="\\"),
                Segment.source_ref.like(pattern, escape="\\"),
            )
        )
    count = int(await session.scalar(select(func.count()).select_from(statement.subquery())) or 0)
    key = Segment.created_at if sort == "created_at" else Segment.updated_at
    rows = (
        await session.scalars(
            statement.order_by(key.asc() if order == "asc" else key.desc(), Segment.id.asc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).all()
    return SegmentCatalogPage(
        items=[segment_response(s) for s in rows], total=count, page=page, page_size=page_size
    )


async def analysis_catalog(
    session: AsyncSession,
    source_id: str,
    q: str,
    sort: Literal["title", "created_at", "updated_at"],
    order: Order,
    page: int,
    page_size: int,
) -> AnalysisCatalogPage:
    await require_source(session, source_id)
    statement = (
        select(Analysis, func.substr(Segment.text, 1, 160))
        .join(Segment, Analysis.segment_id == Segment.id)
        .where(
            Segment.source_id == source_id,
            Segment.deleted_at.is_(None),
            Analysis.deleted_at.is_(None),
        )
    )
    if q:
        pattern = literal_search(q)
        statement = statement.where(
            or_(
                Analysis.title.like(pattern, escape="\\"),
                Analysis.excerpt.like(pattern, escape="\\"),
            )
        )
    count = int(await session.scalar(select(func.count()).select_from(statement.subquery())) or 0)
    key = {
        "title": Analysis.title.collate("BINARY"),
        "created_at": Analysis.created_at,
        "updated_at": Analysis.updated_at,
    }[sort]
    rows = (
        await session.execute(
            statement.order_by(key.asc() if order == "asc" else key.desc(), Analysis.id.asc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).all()
    return AnalysisCatalogPage(
        items=[
            AnalysisCatalogItem(
                id=a.id,
                segment_id=a.segment_id,
                title=a.title,
                excerpt=a.excerpt,
                current_revision_id=a.current_revision_id,
                created_at=as_utc(a.created_at),
                updated_at=as_utc(a.updated_at),
                segment_excerpt=excerpt,
            )
            for a, excerpt in rows
        ],
        total=count,
        page=page,
        page_size=page_size,
    )
