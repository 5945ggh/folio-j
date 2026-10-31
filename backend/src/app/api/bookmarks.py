"""Thin material-bookmark routes."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.bookmark_schemas import (
    BookmarkCreate,
    BookmarkNearbyResponse,
    BookmarkResponse,
    BookmarksResponse,
    BookmarkUpdate,
)
from app.db import get_session
from app.services import bookmarks

router = APIRouter(prefix="/api/materials/{material_id}/bookmarks")
Session = Annotated[AsyncSession, Depends(get_session)]


@router.get("", response_model=BookmarksResponse, operation_id="listMaterialBookmarks")
async def list_bookmarks(
    material_id: str,
    version_id: str,
    session: Session,
    request: Request,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=100)] = 40,
) -> BookmarksResponse:
    return await bookmarks.list_bookmarks(
        session, material_id, version_id, offset, limit, request.app.state.reader_views
    )


@router.post(
    "",
    response_model=BookmarkResponse | BookmarkNearbyResponse,
    operation_id="createMaterialBookmark",
)
async def create_bookmark(
    material_id: str, data: BookmarkCreate, session: Session, request: Request
) -> BookmarkResponse | BookmarkNearbyResponse:
    return await bookmarks.create_bookmark(
        session, material_id, data, request.app.state.reader_views
    )


@router.get("/{bookmark_id}", response_model=BookmarkResponse, operation_id="getMaterialBookmark")
async def get_bookmark(
    material_id: str, bookmark_id: str, session: Session, request: Request
) -> BookmarkResponse:
    return await bookmarks.get_bookmark(
        session, material_id, bookmark_id, request.app.state.reader_views
    )


@router.patch(
    "/{bookmark_id}", response_model=BookmarkResponse, operation_id="updateMaterialBookmark"
)
async def update_bookmark(
    material_id: str, bookmark_id: str, data: BookmarkUpdate, session: Session, request: Request
) -> BookmarkResponse:
    return await bookmarks.update_bookmark(
        session, material_id, bookmark_id, data, request.app.state.reader_views
    )


@router.delete("/{bookmark_id}", status_code=204, operation_id="deleteMaterialBookmark")
async def delete_bookmark(
    material_id: str,
    bookmark_id: str,
    session: Session,
    expected_revision: Annotated[int, Query(ge=0)],
) -> Response:
    await bookmarks.delete_bookmark(session, material_id, bookmark_id, expected_revision)
    return Response(status_code=204)
