"""Offline, deterministic reader service measurements against a disposable SQLite DB.

Run with backend/.venv/bin/python scripts/measure_reader_backend.py --output /tmp/reader.json.
No application lifespan, user database, network, or model is used. Synthetic assets
contain complete, nonempty token coverage and distinct incompressible PNG pixels.
Service timings exclude HTTP serialization and fixture construction. Latency and
tracemalloc runs are separate; RSS is the process lifetime high-water mark.
Default mode uses the benchmark-local flows frozen from 7747434; --reader-views
uses current production services and their runtime.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import gc
import hashlib
import importlib
import json
import platform
import random
import resource
import statistics
import struct
import sys
import tempfile
import threading
import time
import tracemalloc
import zlib
from collections.abc import Awaitable, Callable
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import asdict, dataclass, field
from functools import partial
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, cast

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend" / "src"))
sys.path.insert(0, str(ROOT / "scripts"))

from app import epub_storage
from app.db import Base, create_engine
from app.epub_schemas import (
    ChapterPart,
    CompiledBook,
    CompiledChapter,
    CompiledResource,
)
from app.material_models import (
    Material,
    MaterialReadingsCurrent,
    MaterialReadingsGeneration,
)
from app.material_schemas import ReadingPositionUpdate
from app.models import Source
from app.nlp import assets
from app.nlp.contracts import (
    DecodedReadings,
    MaterialReadingToken,
    MaterialResourceReadings,
)
from app.nlp.tokenization import GeneratedReadings, generate
from app.readings_schemas import MaterialReadingsResponse
from app.services import materials, reader_queries, readings
from app.services.epub import compile_epub_bytes
from app.services.epub_readings import chapter_resources, text_resources
from app.services.sources import utc_now
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

baseline = importlib.import_module("reader_measurement_baseline")

if TYPE_CHECKING:
    from app.services.reader_views import ReaderViews


@dataclass(frozen=True)
class Scale:
    chapters: int
    tokens_per_chapter: int
    images: int
    image_side: int


SCALES = {
    "small": Scale(4, 500, 2, 128),
    "medium": Scale(24, 1000, 8, 256),
    "large": Scale(60, 1500, 16, 512),
}
SEED = 20261028
WORDS = ("日本", "学校", "読書", "物語", "空色", "時間", "友人", "教室", "音楽", "散歩")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def png(rng: random.Random, side: int) -> bytes:
    """A valid RGB PNG with seeded random pixels (no image dependency)."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data))
        )

    pixels = b"".join(b"\0" + rng.randbytes(side * 3) for _ in range(side))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", side, side, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(pixels))
        + chunk(b"IEND", b"")
    )


def synthetic(
    name: str, scale: Scale
) -> tuple[CompiledBook, GeneratedReadings, dict[str, object]]:
    rng = random.Random(SEED)
    resources: list[CompiledResource] = []
    chapters: list[CompiledChapter] = []
    lexical: list[MaterialResourceReadings] = []
    image_bytes = 0
    for index in range(scale.chapters):
        words = [rng.choice(WORDS) for _ in range(scale.tokens_per_chapter)]
        text = "".join(words)
        identity = f"r{index}"
        text_digest = digest(text.encode())
        markup = f'<p><span data-locator-leaf="0">{text}</span></p>'
        if index < scale.images:
            image = png(rng, scale.image_side)
            image_bytes += len(image)
            uri = "data:image/png;base64," + base64.b64encode(image).decode()
            markup += f'<img data-epub-image="{index}" src="{uri}" alt="{index}"/>'
        resources.append(
            CompiledResource(
                id=identity,
                href=f"c{index}.xhtml",
                title=f"章{index}",
                text=text,
                css="",
                html_attributes={},
                body_attributes={},
                text_sha256=text_digest,
            )
        )
        chapters.append(
            CompiledChapter(
                id=f"c{index}",
                title=f"章{index}",
                level=1,
                parts=[
                    ChapterPart(
                        resource_id=identity,
                        spine_index=index,
                        start=0,
                        end=len(text),
                        html=markup,
                        leaf_start=0,
                        leaf_end=1,
                    )
                ],
            )
        )
        lexical.append(
            MaterialResourceReadings(
                resource_id=identity,
                text_sha256=text_digest,
                tokens=[
                    MaterialReadingToken(
                        start=i * 2,
                        end=i * 2 + 2,
                        surface=word,
                        reading=f"ヨミ{i % 97}",
                        dictionary_form=word,
                        normalized_form=word,
                        pos=["名詞", "普通名詞", "一般", "*", "*", "*"],
                        is_oov=False,
                    )
                    for i, word in enumerate(words)
                ],
            )
        )
    book = CompiledBook(
        contract="epub-reading-v2",
        title=f"測定-{name}",
        warnings=[],
        resources=resources,
        chapters=chapters,
        product_sha256="0" * 64,
    )
    book = book.model_copy(
        update={"product_sha256": digest(book.model_dump_json().encode())}
    )
    raw = DecodedReadings(
        configuration="synthetic-complete-tokens-v1", resources=lexical
    )
    payload = raw.model_dump_json().encode()
    generated = GeneratedReadings(
        configuration=raw.configuration,
        asset_sha256=digest(payload),
        token_count=sum(len(r.tokens) for r in lexical),
        payload=zlib.compress(payload),
    )
    # Use production validation once before timing, including complete text coverage.
    assets.decode(generated.payload, text_resources(book))
    return (
        book,
        generated,
        {"scale": asdict(scale), "seed": SEED, "image_bytes": image_bytes},
    )


@dataclass
class Probe:
    sql: int = 0
    bundle_selects: int = 0
    readings_selects: int = 0
    epub_decodes: int = 0
    readings_decodes: int = 0
    epub_decode_ms: float = 0
    readings_decode_ms: float = 0
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def snapshot(self) -> dict[str, int | float]:
        return {
            key: value
            for key, value in vars(self).items()
            if isinstance(value, int | float)
        }


ACTIVE: ContextVar[Probe | None] = ContextVar("reader_measurement", default=None)


@contextmanager
def instrument_decoders():
    """Patch already imported aliases too, without changing production modules on disk."""
    patches: list[tuple[object, str, object]] = []
    for original, name in ((epub_storage.decode, "epub"), (assets.decode, "readings")):

        def wrapper(
            *args: Any,
            _original: Callable[..., Any] = original,
            _name: str = name,
            **kwargs: Any,
        ) -> Any:
            probe = ACTIVE.get()
            start = time.perf_counter()
            try:
                return _original(*args, **kwargs)
            finally:
                if probe is not None:
                    with probe.lock:
                        count = f"{_name}_decodes"
                        elapsed = f"{_name}_decode_ms"
                        setattr(probe, count, getattr(probe, count) + 1)
                        setattr(
                            probe,
                            elapsed,
                            getattr(probe, elapsed)
                            + (time.perf_counter() - start) * 1000,
                        )

        for module in tuple(sys.modules.values()):
            module_name = getattr(module, "__name__", "")
            if module_name.startswith("app.") or module_name == baseline.__name__:
                for attribute, value in tuple(vars(module).items()):
                    if value is original:
                        patches.append((module, attribute, value))
                        setattr(module, attribute, wrapper)
    try:
        yield
    finally:
        for module, name, original in patches:
            setattr(module, name, original)


@dataclass(frozen=True)
class Fixture:
    name: str
    material_id: str
    version_id: str
    chapter_id: str
    part_index: int
    resource_id: str
    offset: int
    image_ordinals: tuple[int, ...]
    metadata: dict[str, object]


def chapter_codepoints(chapter: CompiledChapter) -> int:
    return sum(part.end - part.start for part in chapter.parts)


def select_chapter(
    book: CompiledBook,
    selection: Literal["first", "largest"],
) -> CompiledChapter:
    candidates = [
        chapter for chapter in book.chapters if chapter_codepoints(chapter) > 0
    ]
    if not candidates:
        raise ValueError("测量书籍需要至少一个含正文的章节")
    return (
        max(candidates, key=chapter_codepoints)
        if selection == "largest"
        else candidates[0]
    )


async def publish_fixture(
    factory: async_sessionmaker[AsyncSession],
    name: str,
    book: CompiledBook,
    generated: GeneratedReadings,
    metadata: dict[str, object],
    *,
    chapter_selection: Literal["first", "largest"] = "first",
) -> Fixture:
    encoded = epub_storage.encode(book)
    identifier = digest(name.encode())[:26]
    version = digest((name + "version").encode())[:26]
    now = utc_now()
    async with factory() as session:
        session.add(Source(id=identifier, title=name, created_at=now, updated_at=now))
        await session.flush()
        session.add(
            Material(
                id=identifier,
                source_id=identifier,
                title=name,
                source_sha256=digest(name.encode()),
                version_id=version,
                product_sha256=book.product_sha256,
                contract_version=book.contract,
                original_bytes=b"synthetic-no-original",
                compiled_bundle=encoded,
                warnings=book.warnings,
                created_at=now,
            )
        )
        await session.flush()
        session.add(
            MaterialReadingsGeneration(
                id=identifier,
                material_id=identifier,
                version_id=version,
                asset_sha256=generated.asset_sha256,
                configuration=generated.configuration,
                token_count=generated.token_count,
                payload=generated.payload,
                created_at=now,
            )
        )
        await session.flush()
        session.add(
            MaterialReadingsCurrent(material_id=identifier, generation_id=identifier)
        )
        await session.commit()
    chapter = select_chapter(book, chapter_selection)
    part = next(p for p in chapter.parts if p.end > p.start)
    response_resources = chapter_resources(generated.payload, book, chapter.id)
    image_count = sum(
        p.html.count("data-epub-image=") for c in book.chapters for p in c.parts
    )
    metadata.update(
        {
            "chapters": len(book.chapters),
            "resources": len(book.resources),
            "text_codepoints": sum(len(r.text) for r in book.resources),
            "token_count": generated.token_count,
            "bundle_bytes": len(encoded),
            "bundle_sha256": digest(encoded),
            "readings_bytes": len(generated.payload),
            "readings_sha256": digest(generated.payload),
            "image_count": image_count,
            "selected_chapter_id": chapter.id,
            "selected_chapter_codepoints": chapter_codepoints(chapter),
            "selected_chapter_response_token_count": sum(
                len(r.tokens) for r in response_resources
            ),
        }
    )
    ordinals = (
        tuple(dict.fromkeys((0, image_count // 2, image_count - 1)))
        if image_count
        else ()
    )
    return Fixture(
        name,
        identifier,
        version,
        chapter.id,
        chapter.parts.index(part),
        part.resource_id,
        part.start,
        ordinals,
        metadata,
    )


async def measure(
    invoke: Callable[[], Awaitable[object]],
    concurrency: int,
    memory: bool,
) -> dict[str, object]:
    gc.collect()
    if memory:
        tracemalloc.start()
    probe = Probe()
    context = ACTIVE.set(probe)
    start = time.perf_counter()
    try:
        results = await asyncio.gather(*(invoke() for _ in range(concurrency)))
        elapsed = (time.perf_counter() - start) * 1000
        peak = tracemalloc.get_traced_memory()[1] if memory else None
        live = tracemalloc.get_traced_memory()[0] if memory else None
        # Keep return values alive until the peak is observed, as an API response is.
        assert len(results) == concurrency
        response_token_counts = [
            sum(len(resource.tokens) for resource in result.resources)
            for result in results
            if isinstance(result, MaterialReadingsResponse)
        ]
        del results
        # gather retains child task results until the next event-loop turn.
        await asyncio.sleep(0)
        gc.collect()
        retained = tracemalloc.get_traced_memory()[0] if memory else None
    finally:
        ACTIVE.reset(context)
        if memory:
            tracemalloc.stop()
    return {
        "elapsed_ms": elapsed,
        "requests": concurrency,
        "peak_python_bytes": peak,
        "live_python_bytes": live,
        "live_after_response_release_bytes": retained,
        "response_token_counts": response_token_counts,
        **probe.snapshot(),
    }


async def benchmark(args: argparse.Namespace) -> dict[str, object]:
    source_hashes = {
        str(path.relative_to(ROOT)): digest(path.read_bytes())
        for path in (
            Path(__file__).resolve(),
            ROOT / "scripts/reader_measurement_baseline.py",
            ROOT / "backend/src/app/services/materials.py",
            ROOT / "backend/src/app/services/readings.py",
            ROOT / "backend/src/app/services/reader_queries.py",
            ROOT / "backend/src/app/services/epub_readings.py",
            ROOT / "backend/src/app/services/reader_views.py",
            ROOT / "backend/src/app/services/reader_view_cache.py",
            ROOT / "backend/src/app/epub_storage.py",
            ROOT / "backend/src/app/nlp/assets.py",
        )
        if path.exists()
    }
    reset: Callable[[], object] | None = None
    if args.reset_hook:
        module, attribute = args.reset_hook.split(":", 1)
        reset = cast(
            Callable[[], object], getattr(importlib.import_module(module), attribute)
        )
    results: list[dict[str, object]] = []
    with tempfile.TemporaryDirectory(prefix="folio-reader-measure-") as directory:
        engine = create_engine(Path(directory) / "measurement.db")
        factory = async_sessionmaker(engine, expire_on_commit=False)
        # Import all ORM registrations, using no application or user configuration.
        importlib.import_module("app.main")

        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

        def sql_probe(
            _connection: object,
            _cursor: object,
            statement: str,
            _parameters: object,
            _context: object,
            _many: bool,
        ) -> None:
            probe = ACTIVE.get()
            if probe is None:
                return
            probe.sql += 1
            projection = statement.lower().split("from", 1)[0]
            if "select" in projection:
                probe.bundle_selects += int("materials.compiled_bundle" in projection)
                probe.readings_selects += int(
                    "material_readings_generations.payload" in projection
                )

        event.listen(engine.sync_engine, "before_cursor_execute", sql_probe)
        try:
            for name in args.sizes:
                start = time.perf_counter()
                book, generated, metadata = synthetic(name, SCALES[name])
                fixture = await publish_fixture(
                    factory,
                    name,
                    book,
                    generated,
                    metadata,
                    chapter_selection=args.chapter_selection,
                )
                del book, generated
                fixture.metadata["construction_seconds"] = time.perf_counter() - start
                results.append(await run_fixture(factory, fixture, args, reset))
            if args.epub:
                start = time.perf_counter()
                raw = Path(args.epub).read_bytes()
                book = await asyncio.to_thread(compile_epub_bytes, raw)
                generated = await asyncio.to_thread(generate, text_resources(book))
                fixture = await publish_fixture(
                    factory,
                    "local-epub",
                    book,
                    generated,
                    {"source_bytes": len(raw), "source_sha256": digest(raw)},
                    chapter_selection=args.chapter_selection,
                )
                del raw, book, generated
                fixture.metadata["construction_seconds"] = time.perf_counter() - start
                results.append(await run_fixture(factory, fixture, args, reset))
        finally:
            await engine.dispose()
    return {
        "format": "reader-backend-measurement-v1",
        "python": sys.version,
        "platform": platform.platform(),
        "seed": SEED,
        "repeats": args.repeats,
        "concurrency": args.concurrency,
        "reader_views": args.reader_views,
        "chapter_selection": args.chapter_selection,
        "baseline_revision": baseline.BASELINE_REVISION,
        "baseline_scope": (
            "benchmark-local frozen position/readings/image service flows; shared current "
            "models/decoders/pure chapter/progress helpers; original position reads BLOB twice"
        ),
        "source_sha256": source_hashes,
        "reset_hook": args.reset_hook,
        "scope": (
            "production services with ReaderViews"
            if args.reader_views
            else "benchmark-local service flows frozen from 7747434"
        )
        + "; excludes HTTP serialization, fixture construction, network/LLM",
        "cold_definition": "new ReaderViews per case/group when enabled; OS/SQLite caches remain warm",
        "memory_definition": "separate tracemalloc pass; live response included, fixture excluded",
        "warm_memory_definition": "new allocations only; previously retained cache allocations excluded",
        "retained_memory_definition": (
            "cold traced live bytes after releasing response and GC; includes runtime and "
            "other surviving request/infrastructure allocations, not an exact cache-size estimate"
        ),
        "runtime_close_definition": "outside request latency/tracemalloc; RSS remains lifetime high-water",
        "decoder_time_definition": "sum of per-call wall times; concurrent calls may overlap",
        "rss_high_water_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        * (1 if sys.platform == "darwin" else 1024),
        "rss_definition": "process lifetime high-water including construction and all earlier cases",
        "fixtures": results,
    }


def new_runtime(
    factory: async_sessionmaker[AsyncSession],
    enabled: bool,
) -> ReaderViews | None:
    if not enabled:
        return None
    module = importlib.import_module("app.services.reader_views")
    constructor = cast("type[ReaderViews]", module.ReaderViews)
    return constructor(factory)


def resident_bytes(runtime: ReaderViews | None) -> int | None:
    """Optional public accounting, distinct from measured Python allocations."""
    value = getattr(runtime, "resident_bytes", None)
    return value if isinstance(value, int) else None


async def close_runtime(runtime: ReaderViews | None) -> dict[str, int | float] | None:
    if runtime is None:
        return None
    started = time.perf_counter()
    await runtime.close()
    return {
        "elapsed_ms": (time.perf_counter() - started) * 1000,
        "rss_lifetime_high_water_bytes_after": resource.getrusage(
            resource.RUSAGE_SELF
        ).ru_maxrss
        * (1 if sys.platform == "darwin" else 1024),
    }


async def run_fixture(
    factory: async_sessionmaker[AsyncSession],
    fixture: Fixture,
    args: argparse.Namespace,
    reset: Callable[[], object] | None,
) -> dict[str, object]:
    revision = 0
    cases: list[dict[str, object]] = []
    operations = ["position", "readings"] + [
        f"image:{i}" for i in fixture.image_ordinals
    ]
    for operation in operations:

        async def invoke(
            runtime: ReaderViews | None, operation: str = operation
        ) -> object:
            nonlocal revision
            async with factory() as session:
                if operation == "position":
                    update = ReadingPositionUpdate(
                        version_id=fixture.version_id,
                        chapter_id=fixture.chapter_id,
                        part_index=fixture.part_index,
                        resource_id=fixture.resource_id,
                        kind="text",
                        offset=fixture.offset,
                        expected_revision=revision,
                    )
                    result = (
                        await baseline.save_position(
                            session, fixture.material_id, update
                        )
                        if runtime is None
                        else await materials.save_position(
                            session, fixture.material_id, update, reader_views=runtime
                        )
                    )
                    revision = result.revision
                    return result
                if operation == "readings":
                    if runtime is None:
                        return await baseline.get_readings(
                            session,
                            fixture.material_id,
                            fixture.version_id,
                            fixture.chapter_id,
                        )
                    return await readings.get_readings(
                        session,
                        fixture.material_id,
                        fixture.version_id,
                        fixture.chapter_id,
                        reader_views=runtime,
                    )
                ordinal = int(operation.split(":")[1])
                if runtime is None:
                    return await baseline.illustration_content(
                        session, fixture.material_id, fixture.version_id, ordinal
                    )
                return await reader_queries.illustration_content(
                    session,
                    fixture.material_id,
                    fixture.version_id,
                    ordinal,
                    reader_views=runtime,
                )

        for concurrency in (1, args.concurrency) if operation != "position" else (1,):
            if reset:
                reset()
            runtime = new_runtime(factory, args.reader_views)
            try:
                with instrument_decoders():
                    invoke_latency = partial(invoke, runtime)
                    cold = await measure(invoke_latency, concurrency, False)
                    warm = [
                        await measure(invoke_latency, concurrency, False)
                        for _ in range(args.repeats)
                    ]
                    latency_resident = resident_bytes(runtime)
            finally:
                latency_close = await close_runtime(runtime)
            if reset:
                reset()
            runtime = new_runtime(factory, args.reader_views)
            try:
                with instrument_decoders():
                    invoke_memory = partial(invoke, runtime)
                    cold_memory = await measure(invoke_memory, concurrency, True)
                    memory_resident = resident_bytes(runtime)
                    warm_memory = await measure(invoke_memory, concurrency, True)
            finally:
                memory_close = await close_runtime(runtime)
            if operation == "readings":
                expected_tokens = fixture.metadata[
                    "selected_chapter_response_token_count"
                ]
                for sample in (cold, *warm, cold_memory, warm_memory):
                    assert (
                        sample["response_token_counts"]
                        == [expected_tokens] * concurrency
                    )
            values = [cast(float, row["elapsed_ms"]) for row in warm]
            cases.append(
                {
                    "operation": operation,
                    "concurrency": concurrency,
                    "first": cold,
                    "warm": warm,
                    "warm_median_ms": statistics.median(values),
                    "warm_max_ms": max(values),
                    "first_memory": cold_memory,
                    "warm_memory": warm_memory,
                    "latency_runtime_resident_bytes": latency_resident,
                    "memory_runtime_resident_bytes": memory_resident,
                    "latency_runtime_close": latency_close,
                    "memory_runtime_close": memory_close,
                }
            )
            print(
                f"{fixture.name} {operation} x{concurrency}: "
                f"{statistics.median(values):.2f} ms; "
                f"peak {cast(int, cold_memory['peak_python_bytes']) / 1048576:.2f} MiB",
                flush=True,
            )
    return {"name": fixture.name, "metadata": fixture.metadata, "cases": cases}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--sizes", nargs="+", choices=tuple(SCALES), default=list(SCALES)
    )
    parser.add_argument("--repeats", type=int, choices=range(1, 21), default=3)
    parser.add_argument("--concurrency", type=int, choices=range(2, 9), default=4)
    parser.add_argument(
        "--chapter-selection",
        choices=("first", "largest"),
        default="first",
        help="choose first text chapter or greatest sum of part codepoint spans",
    )
    parser.add_argument(
        "--reader-views",
        action="store_true",
        help="use one ReaderViews per independent cold/warm latency or memory group",
    )
    parser.add_argument(
        "--reset-hook",
        help="optional synchronous module:function clearing runtime caches",
    )
    parser.add_argument(
        "--epub",
        type=Path,
        help="optional local read-only EPUB; report contains no contents",
    )
    args = parser.parse_args()
    report = asyncio.run(benchmark(args))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Saved {args.output}")


if __name__ == "__main__":
    main()
