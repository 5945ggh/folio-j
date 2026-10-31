"""Real SQLite reader views: shared work, private values, visibility and bounded lifetime."""

import asyncio
import base64
import hashlib
import sqlite3
import threading
import zlib
from collections.abc import AsyncGenerator, Callable, Sequence
from contextlib import asynccontextmanager
from dataclasses import FrozenInstanceError, dataclass
from pathlib import Path
from typing import Any, cast

import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy import event
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from support_api import chat_client
from support_epub import compiled

from app import epub_storage
from app.epub_schemas import CompiledBook
from app.ids import new_ulid
from app.material_models import MaterialReadingsCurrent, MaterialReadingsGeneration
from app.material_schemas import ReadingPositionUpdate
from app.nlp.contracts import (
    DecodedReadings,
    MaterialReadingToken,
    MaterialResourceReadings,
    TextResource,
)
from app.nlp.tokenization import GeneratedReadings
from app.readings_schemas import MaterialReadingsResponse
from app.services import materials, reader_views
from app.services.reader_view_cache import retained_bytes
from app.services.reader_views import ReaderViews
from app.services.sources import utc_now

PNG = b"\x89PNG\r\n\x1a\nsynthetic-reader-image"
TEXT = "😀日本𠮷語"


def book_fixture(_raw: bytes = b"") -> CompiledBook:
    book = compiled(b"")
    resource = book.resources[0].model_copy(
        update={"text": TEXT, "text_sha256": hashlib.sha256(TEXT.encode()).hexdigest()}
    )
    image = (
        '<img data-epub-image="0" src="data:image/png;base64,'
        + base64.b64encode(PNG).decode()
        + '">'
    )
    part = (
        book.chapters[0]
        .parts[0]
        .model_copy(
            update={
                "end": len(TEXT),
                "html": '<span data-locator-leaf="0">😀日</span>'
                + image
                + '<span data-locator-leaf="1">本𠮷語</span>',
            }
        )
    )
    first = book.chapters[0].model_copy(update={"parts": [part]})
    second = first.model_copy(
        update={"id": "c2", "parts": [part.model_copy(update={"spine_index": 1})]}
    )
    return book.model_copy(update={"resources": [resource, resource], "chapters": [first, second]})


def lexical_fixture(resources: Sequence[TextResource], label: str = "旧") -> GeneratedReadings:
    configuration = "synthetic-" + label
    decoded = DecodedReadings(
        configuration=configuration,
        resources=[
            MaterialResourceReadings(
                resource_id=resource.resource_id,
                text_sha256=resource.text_sha256,
                tokens=[
                    MaterialReadingToken(
                        start=index,
                        end=index + 1,
                        surface=character,
                        reading=label,
                        dictionary_form=character,
                        normalized_form=character,
                        pos=["名詞", "普通名詞", "一般", "*", "*", "*"],
                        is_oov=False,
                    )
                    for index, character in enumerate(resource.text)
                ],
            )
            for resource in resources
        ],
    )
    payload = zlib.compress(decoded.model_dump_json().encode())
    return GeneratedReadings(
        configuration,
        hashlib.sha256(payload).hexdigest(),
        sum(len(r.tokens) for r in decoded.resources),
        payload,
    )


@dataclass
class Seed:
    database: Path
    client: AsyncClient
    factory: async_sessionmaker[AsyncSession]
    engine: AsyncEngine
    views: ReaderViews
    source: str
    material: dict[str, Any]

    @property
    def material_id(self) -> str:
        return self.material["id"]

    @property
    def version(self) -> str:
        return self.material["version_id"]

    def position(self, **changes: Any) -> ReadingPositionUpdate:
        return ReadingPositionUpdate.model_validate(
            dict(
                version_id=self.version,
                chapter_id="c1",
                part_index=0,
                resource_id="r1",
                kind="text",
                offset=3,
                expected_revision=0,
            )
            | changes
        )

    async def readings(
        self, chapter: str = "c1", generation: str | None = None
    ) -> MaterialReadingsResponse:
        return await self.views.chapter_readings(
            self.material_id, self.version, chapter, generation
        )

    async def image(self) -> tuple[bytes, str]:
        return await self.views.image_content(self.material_id, self.version, 0)

    async def another(self) -> dict[str, Any]:
        response = await self.client.post(
            f"/api/sources/{self.source}/materials",
            content=b"second",
            headers={"content-type": "application/epub+zip"},
        )
        assert response.status_code == 200, response.text
        return response.json()["material"]


@asynccontextmanager
async def seeded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **limits: int
) -> AsyncGenerator[Seed, None]:
    monkeypatch.setattr(materials, "compile_epub_bytes", book_fixture)

    async def build(resources: Sequence[TextResource]) -> GeneratedReadings:
        return lexical_fixture(resources)

    monkeypatch.setattr("app.services.readings.build", build)
    database = tmp_path / "views.db"
    async with chat_client(database) as (client, app):
        source = (await client.post("/api/sources", json={"title": "缓存测试"})).json()["id"]
        response = await client.post(
            f"/api/sources/{source}/materials",
            content=b"first",
            headers={"content-type": "application/epub+zip"},
        )
        assert response.status_code == 200, response.text
        factory = cast(async_sessionmaker[AsyncSession], app.state.session_factory)
        views = ReaderViews(factory, **limits)
        try:
            yield Seed(
                database,
                client,
                factory,
                cast(AsyncEngine, factory.kw["bind"]),
                views,
                source,
                response.json()["material"],
            )
        finally:
            await views.close()


def count_decodes(monkeypatch: pytest.MonkeyPatch) -> dict[str, int]:
    counts = {"book": 0, "readings": 0}
    original_book, original_readings = reader_views.decode_epub, reader_views.decode_readings

    def book(payload: bytes) -> CompiledBook:
        counts["book"] += 1
        return original_book(payload)

    def readings(payload: bytes, resources: Sequence[TextResource]) -> DecodedReadings:
        counts["readings"] += 1
        return original_readings(payload, resources)

    monkeypatch.setattr(reader_views, "decode_epub", book)
    monkeypatch.setattr(reader_views, "decode_readings", readings)
    return counts


def paused_decode(monkeypatch: pytest.MonkeyPatch) -> tuple[threading.Event, threading.Event]:
    entered, release = threading.Event(), threading.Event()
    original = reader_views.decode_epub

    def decode(payload: bytes) -> CompiledBook:
        entered.set()
        assert release.wait(10), "test did not release book decoder"
        return original(payload)

    monkeypatch.setattr(reader_views, "decode_epub", decode)
    return entered, release


@pytest.mark.asyncio
async def test_warm_views_and_position_cas_select_no_large_values_or_decode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async with seeded(tmp_path, monkeypatch) as seed:
        counts = count_decodes(monkeypatch)
        initial = await seed.readings()
        assert len(initial.resources) == 2  # Repeated spine resource ordering is preserved.
        assert await seed.image() == (PNG, "image/png")
        checked = await seed.views.validate_position(seed.material_id, seed.position())
        assert checked.progress == pytest.approx(3 / len(TEXT))
        with pytest.raises(FrozenInstanceError):
            cast(Any, checked).progress = 0.1
        before = counts.copy()
        statements: list[str] = []

        def sql(
            _connection: Connection,
            _cursor: object,
            statement: str,
            _parameters: object,
            _context: object,
            _many: bool,
        ) -> None:
            statements.append(statement.lower())

        event.listen(seed.engine.sync_engine, "before_cursor_execute", sql)
        try:
            await seed.readings("c2")
            assert await seed.image() == (PNG, "image/png")
            async with seed.factory() as session:
                saved = await materials.save_position(
                    session, seed.material_id, seed.position(), reader_views=seed.views
                )
            assert saved.revision == 1 and saved.progress == checked.progress
            async with seed.factory() as session:
                with pytest.raises(HTTPException) as conflict:
                    await materials.save_position(
                        session, seed.material_id, seed.position(), reader_views=seed.views
                    )
            assert conflict.value.status_code == 409
        finally:
            event.remove(seed.engine.sync_engine, "before_cursor_execute", sql)
        assert any("begin immediate" in statement for statement in statements)
        for statement in statements:
            if statement.lstrip().startswith("select"):
                projection = statement.split("from", 1)[0]
                assert "compiled_bundle" not in projection
                assert "material_readings_generations.payload" not in projection
        assert counts == before == {"book": 1, "readings": 1}


@pytest.mark.asyncio
async def test_concurrent_chapters_share_decodes_and_return_deeply_private_tokens(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async with seeded(tmp_path, monkeypatch, concurrency=1, max_pending=1) as seed:
        counts = count_decodes(monkeypatch)
        entered, release = paused_decode(monkeypatch)
        requests = [
            asyncio.create_task(seed.readings(chapter)) for chapter in ("c1", "c2", "c1", "c2")
        ]
        try:
            assert await asyncio.to_thread(entered.wait, 5)
        finally:
            release.set()
        results = await asyncio.wait_for(asyncio.gather(*requests), 5)
        assert counts == {"book": 1, "readings": 1}
        expected = results[1].model_dump()
        results[0].resources[0].tokens[0].reading = "污染"
        results[0].resources[0].tokens[0].pos[0] = "污染"
        results[0].resources[0].tokens.clear()
        assert results[1].model_dump() == expected
        assert (await seed.readings("c2")).model_dump() == expected


@pytest.mark.asyncio
async def test_current_generation_switches_while_explicit_old_generation_stays_available(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.services.epub_readings import text_resources

    async with seeded(tmp_path, monkeypatch) as seed:
        counts = count_decodes(monkeypatch)
        old = await seed.readings()
        generated = lexical_fixture(text_resources(book_fixture()), "新")
        generation = new_ulid()
        async with seed.factory() as session:
            session.add(
                MaterialReadingsGeneration(
                    id=generation,
                    material_id=seed.material_id,
                    version_id=seed.version,
                    asset_sha256=generated.asset_sha256,
                    configuration=generated.configuration,
                    token_count=generated.token_count,
                    payload=generated.payload,
                    created_at=utc_now(),
                )
            )
            pointer = await session.get(MaterialReadingsCurrent, seed.material_id)
            assert pointer is not None
            pointer.generation_id = generation
            await session.commit()
        new = await seed.readings()
        assert new.generation_id == generation and new.resources[0].tokens[0].reading == "新"
        assert (await seed.readings(generation=old.generation_id)).model_dump() == old.model_dump()
        assert counts == {"book": 1, "readings": 2}


def change_material(seed: Seed, change: str) -> None:
    with sqlite3.connect(seed.database) as connection:
        if change == "source":
            connection.execute(
                "UPDATE sources SET deleted_at=? WHERE id=?", (utc_now().isoformat(), seed.source)
            )
        elif change == "material":
            connection.execute(
                "UPDATE materials SET deleted_at=? WHERE id=?",
                (utc_now().isoformat(), seed.material_id),
            )
        else:
            connection.execute(
                "UPDATE materials SET version_id=? WHERE id=?",
                ("changed-version", seed.material_id),
            )


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["source", "material", "version"])
@pytest.mark.parametrize("warm", [False, True])
async def test_visibility_and_version_gates_reject_hot_and_inflight_books(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, change: str, warm: bool
) -> None:
    async with seeded(tmp_path, monkeypatch) as seed:
        if warm:
            await seed.readings()
            await seed.image()
            change_material(seed, change)
        else:
            entered, release = paused_decode(monkeypatch)
            pending = asyncio.create_task(seed.image())
            try:
                assert await asyncio.to_thread(entered.wait, 5)
                await asyncio.to_thread(change_material, seed, change)
            finally:
                release.set()
            with pytest.raises(HTTPException) as rejected:
                await pending
            assert rejected.value.status_code == (409 if change == "version" else 404)
        operations: list[Callable[[], Any]] = [
            seed.image,
            seed.readings,
            lambda: seed.views.validate_position(seed.material_id, seed.position()),
        ]
        for index, operation in enumerate(operations):
            with pytest.raises(HTTPException) as rejected:
                await operation()
            assert rejected.value.status_code == (
                422 if change == "version" and index == 2 else 409 if change == "version" else 404
            )


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["source", "material", "version"])
async def test_inflight_readings_decode_rechecks_material_identity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, change: str
) -> None:
    async with seeded(tmp_path, monkeypatch) as seed:
        await seed.image()
        entered, release = threading.Event(), threading.Event()
        original = reader_views.decode_readings

        def decode(payload: bytes, resources: Sequence[TextResource]) -> DecodedReadings:
            entered.set()
            assert release.wait(10), "test did not release lexical decoder"
            return original(payload, resources)

        monkeypatch.setattr(reader_views, "decode_readings", decode)
        pending = asyncio.create_task(seed.readings())
        try:
            assert await asyncio.to_thread(entered.wait, 5)
            await asyncio.to_thread(change_material, seed, change)
        finally:
            release.set()
        with pytest.raises(HTTPException) as rejected:
            await pending
        assert rejected.value.status_code == (409 if change == "version" else 404)


@pytest.mark.asyncio
async def test_position_write_rechecks_full_identity_after_cached_validation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async with seeded(tmp_path, monkeypatch) as seed:
        await seed.views.validate_position(seed.material_id, seed.position())
        original_begin = materials.begin_write

        async def replace_before_write(session: AsyncSession) -> None:
            with sqlite3.connect(seed.database) as connection:
                connection.execute(
                    "UPDATE materials SET product_sha256=? WHERE id=?",
                    ("changed", seed.material_id),
                )
            await original_begin(session)

        monkeypatch.setattr(materials, "begin_write", replace_before_write)
        async with seed.factory() as session:
            with pytest.raises(HTTPException) as changed:
                await materials.save_position(
                    session, seed.material_id, seed.position(), reader_views=seed.views
                )
        assert changed.value.status_code == 409
        with sqlite3.connect(seed.database) as connection:
            assert connection.execute("SELECT count(*) FROM reading_positions").fetchone() == (0,)
            assert connection.execute(
                "SELECT count(*) FROM chapter_reading_positions"
            ).fetchone() == (0,)


@pytest.mark.asyncio
async def test_cancelled_waiter_does_not_cancel_shared_decode_and_pending_is_bounded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async with seeded(tmp_path, monkeypatch, max_pending=1, concurrency=1) as seed:
        other = await seed.another()
        counts = count_decodes(monkeypatch)
        entered, release = paused_decode(monkeypatch)
        first = asyncio.create_task(seed.image())
        second: asyncio.Task[tuple[bytes, str]] | None = None
        try:
            assert await asyncio.to_thread(entered.wait, 5)
            first.cancel()
            with pytest.raises(asyncio.CancelledError):
                await first
            second = asyncio.create_task(seed.image())
            with pytest.raises(HTTPException) as full:
                await seed.views.image_content(other["id"], other["version_id"], 0)
            assert full.value.status_code == 503
        finally:
            release.set()
        assert second is not None and await second == (PNG, "image/png")
        assert counts["book"] == 1
        assert await seed.views.image_content(other["id"], other["version_id"], 0) == (
            PNG,
            "image/png",
        )


@pytest.mark.asyncio
async def test_close_drains_admitted_decode_and_rejects_new_requests(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async with seeded(tmp_path, monkeypatch) as seed:
        entered, release = paused_decode(monkeypatch)
        request = asyncio.create_task(seed.image())
        closing: asyncio.Task[None] | None = None
        try:
            assert await asyncio.to_thread(entered.wait, 5)
            closing = asyncio.create_task(seed.views.close())
            await asyncio.sleep(0)
            with pytest.raises(HTTPException) as closed:
                await seed.image()
            assert closed.value.status_code == 503
            assert not closing.done()
        finally:
            release.set()
        assert await request == (PNG, "image/png")
        assert closing is not None
        await closing


@pytest.mark.asyncio
async def test_close_also_drains_projection_threads_after_a_cache_hit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async with seeded(tmp_path, monkeypatch) as seed:
        await seed.image()
        entered, release = threading.Event(), threading.Event()
        original = vars(reader_views)["_image"]

        def image(*args: Any) -> tuple[bytes, str]:
            entered.set()
            assert release.wait(10), "test did not release image projection"
            return original(*args)

        monkeypatch.setattr(reader_views, "_image", image)
        request = asyncio.create_task(seed.image())
        closing: asyncio.Task[None] | None = None
        try:
            assert await asyncio.to_thread(entered.wait, 5)
            closing = asyncio.create_task(seed.views.close())
            await asyncio.sleep(0)
            assert not closing.done(), (
                "close returned while an admitted projection thread was running"
            )
        finally:
            release.set()
        assert await request == (PNG, "image/png")
        assert closing is not None
        await closing


@pytest.mark.asyncio
async def test_hot_projection_admission_is_bounded_and_cancelled_queue_does_not_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async with seeded(tmp_path, monkeypatch, concurrency=1, max_requests=3) as seed:
        await seed.image()
        entered, release = threading.Event(), threading.Event()
        original = vars(reader_views)["_image"]
        original_project = vars(ReaderViews)["_project"]
        queued = asyncio.Event()
        calls = 0
        projections = 0

        def image(*args: Any) -> tuple[bytes, str]:
            nonlocal calls
            calls += 1
            entered.set()
            assert release.wait(10), "test did not release admitted projection"
            return original(*args)

        async def project(
            views: ReaderViews, work: Callable[..., Any], *args: Any, **kwargs: Any
        ) -> Any:
            nonlocal projections
            projections += 1
            if projections == 3:
                queued.set()
            return await original_project(views, work, *args, **kwargs)

        monkeypatch.setattr(reader_views, "_image", image)
        monkeypatch.setattr(ReaderViews, "_project", project)
        first = asyncio.create_task(seed.image())
        waiting: list[asyncio.Task[tuple[bytes, str]]] = []
        closing: asyncio.Task[None] | None = None
        try:
            assert await asyncio.to_thread(entered.wait, 5)
            waiting = [asyncio.create_task(seed.image()) for _ in range(2)]
            await asyncio.wait_for(queued.wait(), 5)
            with pytest.raises(HTTPException) as full:
                await asyncio.wait_for(seed.image(), 0.5)
            assert full.value.status_code == 503
            for request in waiting:
                request.cancel()
            cancelled = await asyncio.gather(*waiting, return_exceptions=True)
            assert all(isinstance(result, asyncio.CancelledError) for result in cancelled)
            async with asyncio.timeout(5):
                while True:
                    replacement = asyncio.create_task(seed.image())
                    waiting.append(replacement)
                    await asyncio.sleep(0)
                    await asyncio.sleep(0)
                    if not replacement.done():
                        break
                    try:
                        await replacement
                    except HTTPException as busy:
                        assert busy.status_code == 503
                        await asyncio.sleep(0.01)
            replacement.cancel()
            await asyncio.gather(replacement, return_exceptions=True)
            first.cancel()
            closing = asyncio.create_task(seed.views.close())
            await asyncio.sleep(0)
            assert not closing.done(), "cancelling a caller must not detach its running thread"
            assert calls == 1
        finally:
            for request in waiting:
                request.cancel()
            release.set()
            await asyncio.gather(first, *waiting, return_exceptions=True)
        assert closing is not None
        await closing
        assert calls == 1, "cancelled queued requests must never reach image projection"


@pytest.mark.asyncio
async def test_small_retained_byte_budget_keeps_book_and_compact_readings_together(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.services.epub_readings import text_resources

    book = epub_storage.decode(epub_storage.encode(book_fixture()))
    decoded = reader_views.decode_readings(
        lexical_fixture(text_resources(book)).payload, text_resources(book)
    )
    logical_rows = tuple(
        (
            resource.resource_id,
            resource.text_sha256,
            tuple(
                (
                    token.start,
                    token.end,
                    token.surface,
                    token.reading,
                    token.dictionary_form,
                    token.normalized_form,
                    tuple(token.pos),
                    token.is_oov,
                )
                for token in resource.tokens
            ),
        )
        for resource in decoded.resources
    )
    # Charge logical immutable rows plus the decoded book and 4 KiB for keys/view metadata.
    # The full mutable DTO tree is larger; it should not evict the reusable book view.
    budget = retained_bytes(book) + retained_bytes(logical_rows) + 4096
    async with seeded(tmp_path, monkeypatch, max_bytes=budget) as seed:
        counts = count_decodes(monkeypatch)
        first = await seed.readings()
        assert len(first.resources[0].tokens) == len(TEXT)
        for chapter in ("c2", "c1", "c2"):
            assert (await seed.readings(chapter)).resources[0].tokens[0].surface == TEXT[0]
        assert counts == {"book": 1, "readings": 1}


@pytest.mark.asyncio
@pytest.mark.parametrize("budget", ["entries", "bytes", "oversize"])
async def test_cache_limits_evict_and_oversized_values_do_not_reside(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, budget: str
) -> None:
    limits = (
        {"max_entries": 1}
        if budget == "entries"
        else {"max_bytes": 1 if budget == "oversize" else 2 * retained_bytes(book_fixture())}
    )
    async with seeded(tmp_path, monkeypatch, **limits) as seed:
        other = await seed.another()
        counts = count_decodes(monkeypatch)
        await seed.views.validate_position(seed.material_id, seed.position())
        await seed.views.validate_position(seed.material_id, seed.position())
        assert counts["book"] == (2 if budget == "oversize" else 1)
        await seed.views.validate_position(
            other["id"], seed.position(version_id=other["version_id"])
        )
        await seed.views.validate_position(seed.material_id, seed.position())
        assert counts["book"] == (4 if budget == "oversize" else 3)


@pytest.mark.asyncio
async def test_failed_decode_releases_pending_admission_for_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async with seeded(tmp_path, monkeypatch, max_pending=1) as seed:
        original = reader_views.decode_epub
        calls = 0

        def decode(payload: bytes) -> CompiledBook:
            nonlocal calls
            calls += 1
            if calls == 1:
                raise ValueError("synthetic corrupted compilation")
            return original(payload)

        monkeypatch.setattr(reader_views, "decode_epub", decode)
        with pytest.raises(ValueError, match="synthetic corrupted"):
            await seed.image()
        assert await seed.image() == (PNG, "image/png")
        assert calls == 2


@pytest.mark.asyncio
async def test_image_and_unicode_position_progress_preserve_existing_semantics(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async with seeded(tmp_path, monkeypatch) as seed:
        assert await seed.views.image_content(seed.material_id, seed.version, 1) == (
            PNG,
            "image/png",
        )
        image = seed.position(kind="image", offset=None, image_id=0, image_progress=0.9)
        assert (
            await seed.views.validate_position(seed.material_id, image)
        ).progress == pytest.approx(2 / 5)
        end = seed.position(offset=5, at_chapter_end=True)
        assert (await seed.views.validate_position(seed.material_id, end)).progress == 1
        with pytest.raises(HTTPException) as invalid:
            await seed.views.validate_position(seed.material_id, seed.position(offset=6))
        assert invalid.value.status_code == 422
