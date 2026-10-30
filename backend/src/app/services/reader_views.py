"""Bounded private reading views over immutable book and analysis identities.

Every public operation gates current visibility independently of cache state. Cached
book trees and compact token tuples stay private; callers receive scalars, bytes or fresh models.
Only admitted loaders read large database values, using their own short sessions.
"""

import asyncio
import base64
import binascii
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from functools import partial
from typing import NamedTuple, ParamSpec, TypeVar

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.epub_schemas import CompiledBook
from app.epub_storage import decode as decode_epub
from app.material_models import Material, MaterialReadingsCurrent, MaterialReadingsGeneration
from app.material_schemas import PositionAnchor, ReadingPositionUpdate
from app.models import Source
from app.nlp.assets import decode as decode_readings
from app.nlp.contracts import MaterialReadingToken, MaterialResourceReadings
from app.readings_schemas import MaterialReadingsResponse
from app.services.bookmark_positions import BookmarkLocation, project_bookmark
from app.services.epub_readings import text_resources
from app.services.position_progress import chapter_progress
from app.services.reader_view_cache import Key, ViewCache

MAX_CACHE_BYTES = 128 * 1024 * 1024
MAX_CACHE_ENTRIES = 8
MAX_COMPUTATIONS = 2
MAX_PENDING_COMPUTATIONS = 8
MAX_REQUESTS = 32
T = TypeVar("T")
P = ParamSpec("P")


@dataclass(frozen=True)
class MaterialIdentity:
    id: str
    source_id: str
    source_sha256: str
    version_id: str
    product_sha256: str
    contract_version: str

    @classmethod
    def from_material(cls, material: Material) -> "MaterialIdentity":
        """Capture only scalar identity; safe for a caller's write-transaction recheck."""
        return cls(
            material.id,
            material.source_id,
            material.source_sha256,
            material.version_id,
            material.product_sha256,
            material.contract_version,
        )


def _identity_key(identity: MaterialIdentity) -> Key:
    return (
        identity.id,
        identity.source_id,
        identity.source_sha256,
        identity.version_id,
        identity.product_sha256,
        identity.contract_version,
    )


@dataclass(frozen=True)
class ValidatedPosition:
    identity: MaterialIdentity
    progress: float | None


@dataclass(frozen=True)
class _Generation:
    id: str
    asset_sha256: str
    configuration: str


@dataclass(frozen=True)
class _BookView:
    book: CompiledBook


class _Token(NamedTuple):
    start: int
    end: int
    surface: str
    reading: str
    dictionary_form: str
    normalized_form: str
    pos: tuple[str, ...]
    is_oov: bool


class _Resource(NamedTuple):
    resource_id: str
    text_sha256: str
    tokens: tuple[_Token, ...]


class _Readings(NamedTuple):
    resources: tuple[_Resource, ...]


def _decode_book(payload: bytes, identity: MaterialIdentity) -> _BookView:
    book = decode_epub(payload)
    if book.product_sha256 != identity.product_sha256 or book.contract != identity.contract_version:
        raise HTTPException(409, "材料版本产物身份不匹配")
    return _BookView(book)


def _image_index(view: _BookView) -> tuple[str, ...]:
    # Build only for image requests: position/NLP reads must not parse book-wide HTML.
    from app.services.reader_queries import _images  # pyright: ignore[reportPrivateUsage]

    return tuple(source for *_, source in _images(view.book))


def _decode_asset(payload: bytes, book: _BookView, generation: _Generation) -> _Readings:
    result = decode_readings(payload, text_resources(book.book))
    if result.configuration != generation.configuration:
        raise ValueError("分词配置与资产不一致")
    resources: list[_Resource] = []
    # Tokens are already fully validated. A tuple avoids each model's attribute dict
    # and field set; repeated part-of-speech values share one immutable tuple.
    positions: dict[tuple[str, ...], tuple[str, ...]] = {}
    for resource in result.resources:
        tokens: list[_Token] = []
        for token in resource.tokens:
            pos = tuple(token.pos)
            pos = positions.setdefault(pos, pos)
            tokens.append(
                _Token(
                    token.start,
                    token.end,
                    token.surface,
                    token.reading,
                    token.dictionary_form,
                    token.normalized_form,
                    pos,
                    token.is_oov,
                )
            )
        resources.append(_Resource(resource.resource_id, resource.text_sha256, tuple(tokens)))
        # This decoder-owned tree never escapes; release each resource's expensive
        # Pydantic nodes as conversion advances rather than retaining both full trees.
        resource.tokens.clear()
    return _Readings(tuple(resources))


def _position(view: _BookView, data: PositionAnchor) -> float | None:
    book = view.book
    chapter = next((chapter for chapter in book.chapters if chapter.id == data.chapter_id), None)
    if chapter is None or data.part_index >= len(chapter.parts):
        raise HTTPException(422, "位置版本或章节无效")
    part = chapter.parts[data.part_index]
    if part.resource_id != data.resource_id:
        raise HTTPException(422, "位置资源不属于章节")
    if data.kind == "text" and (data.offset is None or not part.start <= data.offset <= part.end):
        raise HTTPException(422, "正文偏移超出章节范围")
    if data.kind == "image" and str(data.image_id) not in re.findall(
        r'data-epub-image=["\'](\d+)["\']', part.html
    ):
        raise HTTPException(422, "图片不属于章节")
    return chapter_progress(book, data)


def _chapter(
    view: _BookView, readings: _Readings, chapter_id: str
) -> list[MaterialResourceReadings]:
    chapter = next((chapter for chapter in view.book.chapters if chapter.id == chapter_id), None)
    if chapter is None:
        raise HTTPException(404, "章节不存在")
    result: list[MaterialResourceReadings] = []
    # Preserve ordered repeated-spine resources, as the existing chapter projection does.
    for resource in readings.resources:
        parts = [part for part in chapter.parts if part.resource_id == resource.resource_id]
        if not parts:
            continue
        result.append(
            MaterialResourceReadings(
                resource_id=resource.resource_id,
                text_sha256=resource.text_sha256,
                tokens=[
                    MaterialReadingToken(
                        start=token.start,
                        end=token.end,
                        surface=token.surface,
                        reading=token.reading,
                        dictionary_form=token.dictionary_form,
                        normalized_form=token.normalized_form,
                        pos=list(token.pos),
                        is_oov=token.is_oov,
                    )
                    for token in resource.tokens
                    if any(token.start < part.end and token.end > part.start for part in parts)
                ],
            )
        )
    return result


def _image(images: tuple[str, ...], ordinal: int) -> tuple[bytes, str]:
    # Retain the reader query module's image-content budget and its existing seam.
    from app.services.reader_queries import MAX_PRODUCT_BYTES

    if ordinal < 0 or ordinal >= len(images):
        raise HTTPException(404, "图片不存在")
    header, encoded = images[ordinal].split(",", 1)
    if len(encoded) > ((MAX_PRODUCT_BYTES + 2) // 3) * 4:
        raise HTTPException(413, "图片超过编译安全大小限制")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(422, "图片数据损坏") from exc
    mime = header[5:].split(";", 1)[0]
    valid = (
        (mime == "image/png" and data.startswith(b"\x89PNG\r\n\x1a\n"))
        or (mime == "image/jpeg" and data.startswith(b"\xff\xd8\xff"))
        or (mime == "image/gif" and data.startswith((b"GIF87a", b"GIF89a")))
        or (mime == "image/webp" and data.startswith(b"RIFF") and data[8:12] == b"WEBP")
    )
    if not valid or len(data) > MAX_PRODUCT_BYTES:
        raise HTTPException(422, "图片类型与内容不符")
    return data, mime


class ReaderViews:
    """Own immutable views and shared work for the three high-frequency read operations.

    Retained views share one byte/entry budget. Pending keys, admitted requests and
    computations have separate limits; none promises a total-process RSS ceiling.
    """

    def __init__(
        self,
        factory: async_sessionmaker[AsyncSession],
        *,
        max_bytes: int = MAX_CACHE_BYTES,
        max_entries: int = MAX_CACHE_ENTRIES,
        concurrency: int = MAX_COMPUTATIONS,
        max_pending: int = MAX_PENDING_COMPUTATIONS,
        max_requests: int = MAX_REQUESTS,
    ) -> None:
        if min(concurrency, max_requests) < 1:
            raise ValueError("阅读计算并发与请求限额必须为正数")
        self._factory = factory
        self._computations = asyncio.Semaphore(concurrency)
        self._cache = ViewCache(
            max_bytes=max_bytes,
            max_entries=max_entries,
            max_pending=max_pending,
            accounting_semaphore=self._computations,
        )
        self._operations: set[asyncio.Task[object]] = set()
        self._projecting: set[asyncio.Task[object]] = set()
        self._max_requests = max_requests
        self._closed = False

    async def _request(self, action: Callable[[], Awaitable[T]]) -> T:
        if self._closed:
            raise HTTPException(503, "阅读服务正在关闭，请稍后重试")
        if len(self._operations) >= self._max_requests:
            raise HTTPException(503, "阅读请求繁忙，请稍后重试")

        async def invoke() -> T:
            return await action()

        task = asyncio.create_task(invoke())
        self._operations.add(task)

        def observe(completed: asyncio.Task[object]) -> None:
            self._operations.discard(completed)
            if not completed.cancelled():
                completed.exception()

        task.add_done_callback(observe)
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            # Retract semaphore/cache waiters. Shared cache loaders remain shielded;
            # an already-started projection drains its own thread before task exit.
            task.cancel()
            if task not in self._projecting:
                # Settle retracted waiters (including short-session rollback/close)
                # before returning cancellation, so their admission slots are reusable.
                await asyncio.shield(asyncio.gather(task, return_exceptions=True))
            raise

    async def _project(self, work: Callable[P, T], *args: P.args, **kwargs: P.kwargs) -> T:
        async with self._computations:
            owner = asyncio.current_task()
            assert owner is not None
            self._projecting.add(owner)
            computation = asyncio.create_task(asyncio.to_thread(work, *args, **kwargs))
            try:
                try:
                    return await asyncio.shield(computation)
                except asyncio.CancelledError:
                    # Cancelling a to_thread await does not stop its thread. Retain the
                    # request slot and permit until the actual work finishes, even if
                    # a caller sends cancellation more than once.
                    while not computation.done():
                        try:
                            await asyncio.shield(computation)
                        except asyncio.CancelledError:
                            continue
                        except Exception:
                            break
                        else:
                            break
                    if not computation.cancelled():
                        computation.exception()
                    raise
            finally:
                self._projecting.discard(owner)

    async def _identity(self, material_id: str) -> MaterialIdentity:
        async with self._factory() as session:
            row = (
                await session.execute(
                    select(
                        Material.id,
                        Material.source_id,
                        Material.source_sha256,
                        Material.version_id,
                        Material.product_sha256,
                        Material.contract_version,
                    )
                    .join(Source, Material.source_id == Source.id)
                    .where(
                        Material.id == material_id,
                        Material.deleted_at.is_(None),
                        Source.deleted_at.is_(None),
                    )
                )
            ).one_or_none()
        if row is None:
            raise HTTPException(404, "材料不存在")
        return MaterialIdentity(*row)

    async def _check(self, identity: MaterialIdentity, *, position: bool = False) -> None:
        if await self._identity(identity.id) != identity:
            raise HTTPException(422 if position else 409, "材料版本已改变")

    async def _generation(
        self, identity: MaterialIdentity, generation_id: str | None
    ) -> _Generation:
        statement = select(
            MaterialReadingsGeneration.id,
            MaterialReadingsGeneration.asset_sha256,
            MaterialReadingsGeneration.configuration,
        ).where(
            MaterialReadingsGeneration.material_id == identity.id,
            MaterialReadingsGeneration.version_id == identity.version_id,
        )
        if generation_id is None:
            statement = statement.join(
                MaterialReadingsCurrent,
                MaterialReadingsCurrent.generation_id == MaterialReadingsGeneration.id,
            ).where(MaterialReadingsCurrent.material_id == identity.id)
        else:
            statement = statement.where(MaterialReadingsGeneration.id == generation_id)
        async with self._factory() as session:
            row = (await session.execute(statement)).one_or_none()
        if row is None:
            if generation_id is not None:
                raise HTTPException(404, "注音代次不存在")
            raise HTTPException(409, "注音尚未准备，请调用准备接口后重试")
        return _Generation(*row)

    async def _load_book(self, identity: MaterialIdentity) -> _BookView:
        async with self._computations:
            async with self._factory() as session:
                payload = await session.scalar(
                    select(Material.compiled_bundle)
                    .join(Source, Material.source_id == Source.id)
                    .where(
                        Material.id == identity.id,
                        Material.source_id == identity.source_id,
                        Material.source_sha256 == identity.source_sha256,
                        Material.version_id == identity.version_id,
                        Material.product_sha256 == identity.product_sha256,
                        Material.contract_version == identity.contract_version,
                        Material.deleted_at.is_(None),
                        Source.deleted_at.is_(None),
                    )
                )
            if payload is None:
                await self._check(identity)
                raise HTTPException(409, "材料版本产物不可用")
            result = await asyncio.to_thread(_decode_book, payload, identity)
            await self._check(identity)
            return result

    async def _book(self, identity: MaterialIdentity) -> _BookView:
        return await self._cache.get(
            ("book", *_identity_key(identity)), partial(self._load_book, identity)
        )

    async def _load_readings(
        self, identity: MaterialIdentity, generation: _Generation, book: _BookView
    ) -> _Readings:
        async with self._computations:
            async with self._factory() as session:
                payload = await session.scalar(
                    select(MaterialReadingsGeneration.payload).where(
                        MaterialReadingsGeneration.id == generation.id,
                        MaterialReadingsGeneration.material_id == identity.id,
                        MaterialReadingsGeneration.version_id == identity.version_id,
                        MaterialReadingsGeneration.asset_sha256 == generation.asset_sha256,
                        MaterialReadingsGeneration.configuration == generation.configuration,
                    )
                )
            if payload is None:
                raise HTTPException(404, "注音代次不存在")
            result = await asyncio.to_thread(_decode_asset, payload, book, generation)
            await self._check(identity)
            if await self._generation(identity, generation.id) != generation:
                raise HTTPException(409, "注音代次已改变")
            return result

    async def _load_images(self, identity: MaterialIdentity, book: _BookView) -> tuple[str, ...]:
        async with self._computations:
            result = await asyncio.to_thread(_image_index, book)
            await self._check(identity)
            return result

    async def validate_position(
        self, material_id: str, data: ReadingPositionUpdate
    ) -> ValidatedPosition:
        # Input models belong to callers and remain mutable while shared work waits.
        return await self._request(
            partial(self._validate_position, material_id, data.model_copy(deep=True))
        )

    async def _validate_position(
        self, material_id: str, data: ReadingPositionUpdate
    ) -> ValidatedPosition:
        identity = await self._identity(material_id)
        if identity.version_id != data.version_id:
            raise HTTPException(422, "位置版本或章节无效")
        book = await self._book(identity)
        progress = await self._project(_position, book, data)
        await self._check(identity, position=True)
        return ValidatedPosition(identity, progress)

    async def bookmark_location(
        self, material_id: str, position: PositionAnchor
    ) -> tuple[MaterialIdentity, BookmarkLocation]:
        return await self._request(
            partial(self._bookmark_location, material_id, position.model_copy(deep=True))
        )

    async def _bookmark_location(
        self, material_id: str, position: PositionAnchor
    ) -> tuple[MaterialIdentity, BookmarkLocation]:
        identity = await self._identity(material_id)
        if identity.version_id != position.version_id:
            raise HTTPException(422, "位置版本或章节无效")
        view = await self._book(identity)

        def project() -> BookmarkLocation:
            _position(view, position)
            return project_bookmark(view.book, position)

        location = await self._project(project)
        await self._check(identity, position=True)
        return identity, location

    async def chapter_readings(
        self,
        material_id: str,
        version_id: str,
        chapter_id: str,
        generation_id: str | None = None,
    ) -> MaterialReadingsResponse:
        return await self._request(
            partial(self._chapter_readings, material_id, version_id, chapter_id, generation_id)
        )

    async def _chapter_readings(
        self,
        material_id: str,
        version_id: str,
        chapter_id: str,
        generation_id: str | None,
    ) -> MaterialReadingsResponse:
        identity = await self._identity(material_id)
        if identity.version_id != version_id:
            raise HTTPException(409, "材料版本已改变")
        generation = await self._generation(identity, generation_id)
        # Complete the dependency before registering the asset computation: no nested
        # pending slots/semaphores, including max_pending=1 and concurrency=1.
        book = await self._book(identity)
        readings = await self._cache.get(
            (
                "readings",
                *_identity_key(identity),
                generation.id,
                generation.asset_sha256,
                generation.configuration,
            ),
            partial(self._load_readings, identity, generation, book),
        )
        resources = await self._project(_chapter, book, readings, chapter_id)
        await self._check(identity)
        if await self._generation(identity, generation.id) != generation:
            raise HTTPException(409, "注音代次已改变")
        return MaterialReadingsResponse(
            material_id=identity.id,
            version_id=identity.version_id,
            generation_id=generation.id,
            resources=resources,
        )

    async def image_content(
        self, material_id: str, version_id: str, ordinal: int
    ) -> tuple[bytes, str]:
        return await self._request(partial(self._image_content, material_id, version_id, ordinal))

    async def _image_content(
        self, material_id: str, version_id: str, ordinal: int
    ) -> tuple[bytes, str]:
        identity = await self._identity(material_id)
        if identity.version_id != version_id:
            raise HTTPException(409, "材料版本已变更，请重新打开")
        book = await self._book(identity)
        images = await self._cache.get(
            ("images", *_identity_key(identity)), partial(self._load_images, identity, book)
        )
        result = await self._project(_image, images, ordinal)
        await self._check(identity)
        return result

    async def close(self) -> None:
        self._closed = True
        try:
            if self._operations:
                draining = asyncio.gather(*tuple(self._operations), return_exceptions=True)
                try:
                    await asyncio.shield(draining)
                except asyncio.CancelledError:
                    await draining
                    raise
        finally:
            await self._cache.close()
