"""Durable bookmarks with frozen retry payloads and note-level optimistic edits."""

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.bookmark_schemas import (
    BookmarkCreate,
    BookmarkNearbyResponse,
    BookmarkResponse,
    BookmarksResponse,
    BookmarkUpdate,
)
from app.ids import new_ulid
from app.material_models import MaterialBookmark
from app.material_schemas import PositionAnchor
from app.services.bookmark_positions import BookmarkLocation, nearby_distance
from app.services.materials import require_material
from app.services.reader_views import MaterialIdentity, ReaderViews
from app.services.sources import as_utc, begin_write, utc_now


def _response(bookmark: MaterialBookmark) -> BookmarkResponse:
    return BookmarkResponse(
        id=bookmark.id,
        material_id=bookmark.material_id,
        position=PositionAnchor.model_validate_json(bookmark.position),
        chapter_title=bookmark.chapter_title,
        excerpt=bookmark.excerpt,
        note=bookmark.note,
        revision=bookmark.revision,
        created_at=as_utc(bookmark.created_at),
        updated_at=as_utc(bookmark.updated_at),
    )


async def _require(session: AsyncSession, material_id: str, bookmark_id: str) -> MaterialBookmark:
    await require_material(session, material_id, with_bundle=False)
    bookmark = await session.scalar(
        select(MaterialBookmark).where(
            MaterialBookmark.material_id == material_id,
            MaterialBookmark.id == bookmark_id,
            MaterialBookmark.deleted_at.is_(None),
        )
    )
    if bookmark is None:
        raise HTTPException(404, "书签不存在")
    return bookmark


async def _with_progress(
    reader_views: ReaderViews, material_id: str, responses: list[BookmarkResponse]
) -> list[BookmarkResponse]:
    progresses = await reader_views.bookmark_progresses(
        material_id, [item.position for item in responses]
    )
    for item, progress in zip(responses, progresses, strict=True):
        item.chapter_progress = progress
    return responses


async def get_bookmark(
    session: AsyncSession, material_id: str, bookmark_id: str, reader_views: ReaderViews
) -> BookmarkResponse:
    response = _response(await _require(session, material_id, bookmark_id))
    return (await _with_progress(reader_views, material_id, [response]))[0]


async def list_bookmarks(
    session: AsyncSession,
    material_id: str,
    version_id: str,
    offset: int,
    limit: int,
    reader_views: ReaderViews,
) -> BookmarksResponse:
    material = await require_material(session, material_id, with_bundle=False)
    if material.version_id != version_id:
        raise HTTPException(409, "材料版本已改变，请重新打开")
    conditions = (
        MaterialBookmark.material_id == material_id,
        MaterialBookmark.version_id == version_id,
        MaterialBookmark.deleted_at.is_(None),
    )
    total = int(
        await session.scalar(select(func.count(MaterialBookmark.id)).where(*conditions)) or 0
    )
    rows = (
        await session.scalars(
            select(MaterialBookmark)
            .where(*conditions)
            .order_by(
                MaterialBookmark.chapter_index,
                MaterialBookmark.part_index,
                MaterialBookmark.position_offset,
                MaterialBookmark.position_order,
                MaterialBookmark.image_progress,
                MaterialBookmark.id,
            )
            .offset(offset)
            .limit(limit)
        )
    ).all()
    return BookmarksResponse(
        material_id=material_id,
        version_id=version_id,
        total=total,
        offset=offset,
        limit=limit,
        items=await _with_progress(reader_views, material_id, [_response(row) for row in rows]),
    )


async def _nearby(
    session: AsyncSession, material_id: str, position: PositionAnchor, location: BookmarkLocation
) -> MaterialBookmark | None:
    candidates = await session.scalars(
        select(MaterialBookmark).where(
            MaterialBookmark.material_id == material_id,
            MaterialBookmark.version_id == position.version_id,
            MaterialBookmark.chapter_index == location.chapter_index,
            MaterialBookmark.part_index == position.part_index,
            MaterialBookmark.position_offset.between(location.nearby_start, location.nearby_end),
            MaterialBookmark.deleted_at.is_(None),
        )
    )
    nearest: tuple[float, str, MaterialBookmark] | None = None
    for candidate in candidates:
        distance = nearby_distance(
            position, PositionAnchor.model_validate_json(candidate.position), location
        )
        if distance is not None and (nearest is None or (distance, candidate.id) < nearest[:2]):
            nearest = distance, candidate.id, candidate
    return nearest[2] if nearest else None


async def create_bookmark(
    session: AsyncSession, material_id: str, data: BookmarkCreate, reader_views: ReaderViews
) -> BookmarkResponse | BookmarkNearbyResponse:
    # Parsing and decoding finish before obtaining the SQLite write reservation.
    data = data.model_copy(deep=True)
    payload = data.position.model_dump_json()
    # A saved request wins before re-projecting a retried position or checking proximity.
    await require_material(session, material_id, with_bundle=False)
    saved = await session.scalar(
        select(MaterialBookmark).where(
            MaterialBookmark.material_id == material_id,
            MaterialBookmark.request_id == str(data.request_id),
        )
    )
    if saved is not None:
        if saved.request_payload != payload:
            raise HTTPException(409, "书签请求内容与首次提交不一致")
        if saved.deleted_at is not None:
            raise HTTPException(404, "书签已删除")
        response = _response(saved)
        return (await _with_progress(reader_views, material_id, [response]))[0]
    await session.rollback()
    identity, location = await reader_views.bookmark_location(material_id, data.position)
    try:
        await begin_write(session)
        material = await require_material(session, material_id, with_bundle=False)
        if MaterialIdentity.from_material(material) != identity:
            raise HTTPException(409, "材料版本已改变，请重新打开")
        existing = await session.scalar(
            select(MaterialBookmark).where(
                MaterialBookmark.material_id == material_id,
                MaterialBookmark.request_id == str(data.request_id),
            )
        )
        if existing is not None:
            if existing.request_payload != payload:
                raise HTTPException(409, "书签请求内容与首次提交不一致")
            if existing.deleted_at is not None:
                raise HTTPException(404, "书签已删除")
            response = _response(existing)
        else:
            nearby = (
                None
                if data.allow_nearby
                else await _nearby(session, material_id, data.position, location)
            )
            if nearby is not None:
                response = _response(nearby)
                await session.commit()
                response = (await _with_progress(reader_views, material_id, [response]))[0]
                return BookmarkNearbyResponse(kind="nearby", bookmark=response)
            now = utc_now()
            bookmark = MaterialBookmark(
                id=new_ulid(),
                material_id=material_id,
                version_id=identity.version_id,
                request_id=str(data.request_id),
                request_payload=payload,
                position=payload,
                chapter_title=location.chapter_title,
                excerpt=location.excerpt,
                note="",
                chapter_index=location.chapter_index,
                part_index=data.position.part_index,
                position_offset=location.position_offset,
                position_order=location.position_order,
                image_progress=data.position.image_progress or 0,
                revision=0,
                created_at=now,
                updated_at=now,
            )
            session.add(bookmark)
            await session.flush()
            response = _response(bookmark)
        await session.commit()
        return (await _with_progress(reader_views, material_id, [response]))[0]
    except BaseException:
        await session.rollback()
        raise


async def update_bookmark(
    session: AsyncSession,
    material_id: str,
    bookmark_id: str,
    data: BookmarkUpdate,
    reader_views: ReaderViews,
) -> BookmarkResponse:
    try:
        await begin_write(session)
        bookmark = await _require(session, material_id, bookmark_id)
        if bookmark.revision != data.expected_revision:
            raise HTTPException(409, "书签已更新，请重新读取")
        if bookmark.note != data.note:
            bookmark.note = data.note
            bookmark.revision += 1
            bookmark.updated_at = utc_now()
        response = _response(bookmark)
        await session.commit()
        return (await _with_progress(reader_views, material_id, [response]))[0]
    except BaseException:
        await session.rollback()
        raise


async def delete_bookmark(
    session: AsyncSession, material_id: str, bookmark_id: str, expected_revision: int
) -> None:
    try:
        await begin_write(session)
        bookmark = await _require(session, material_id, bookmark_id)
        if bookmark.revision != expected_revision:
            raise HTTPException(409, "书签已更新，请重新读取")
        deleted = utc_now()
        bookmark.deleted_at = deleted
        bookmark.updated_at = deleted
        bookmark.revision += 1
        await session.commit()
    except BaseException:
        await session.rollback()
        raise
