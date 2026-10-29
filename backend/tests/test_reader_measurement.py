"""Check that performance fixtures carry real work and counters survive thread dispatch."""

import asyncio
import importlib
import sys
from pathlib import Path
from types import ModuleType

import pytest
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker

from app import epub_storage
from app.db import Base, create_engine
from app.material_models import Material
from app.material_schemas import ReadingPositionUpdate
from app.nlp import assets
from app.services.epub_readings import text_resources

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
measurement = importlib.import_module("scripts.measure_reader_backend")


def test_measurement_fixture_is_reproducible_and_has_complete_tokens_and_distinct_images() -> None:
    scale = measurement.Scale(3, 12, 3, 16)
    book, generated, metadata = measurement.synthetic("test", scale)
    again, generated_again, metadata_again = measurement.synthetic("test", scale)
    assert epub_storage.encode(book) == epub_storage.encode(again)
    assert generated.payload == generated_again.payload
    assert metadata == metadata_again
    decoded = assets.decode(generated.payload, text_resources(book))
    assert generated.token_count == 36
    for lexical, source in zip(decoded.resources, book.resources, strict=True):
        assert "".join(token.surface for token in lexical.tokens) == source.text
        assert len({token.surface for token in lexical.tokens}) > 1
    images = [chapter.parts[0].html.split('src="')[1].split('"')[0] for chapter in book.chapters]
    assert len(set(images)) == 3
    assert metadata["image_bytes"] > 3 * 16 * 16 * 3


def test_chapter_selection_uses_actual_part_spans_and_stable_order() -> None:
    book, _, _ = measurement.synthetic("selection", measurement.Scale(4, 10, 0, 1))
    first, second, third, fourth = book.chapters
    chapters = [
        first.model_copy(update={"parts": [first.parts[0].model_copy(update={"end": 0})]}),
        second.model_copy(update={"parts": [second.parts[0].model_copy(update={"end": 5})]}),
        third.model_copy(
            update={
                "parts": [
                    third.parts[0].model_copy(update={"end": 8}),
                    third.parts[0].model_copy(update={"start": 8, "end": 19}),
                ]
            }
        ),
        fourth.model_copy(update={"parts": [fourth.parts[0].model_copy(update={"end": 19})]}),
    ]
    book = book.model_copy(update={"chapters": chapters})
    assert measurement.select_chapter(book, "first").id == second.id
    assert measurement.select_chapter(book, "largest").id == third.id
    assert measurement.chapter_codepoints(chapters[2]) == 19
    with pytest.raises(ValueError, match="至少一个"):
        measurement.select_chapter(book.model_copy(update={"chapters": chapters[:1]}), "largest")


@pytest.mark.asyncio
async def test_measurement_decoders_count_threads_and_restore_imported_aliases() -> None:
    book, generated, _ = measurement.synthetic("test", measurement.Scale(1, 10, 0, 1))
    compiled = epub_storage.encode(book)
    original = epub_storage.decode
    alias = ModuleType("app.measurement_alias")
    vars(alias)["decode"] = original
    sys.modules[alias.__name__] = alias
    probe = measurement.Probe()
    context = measurement.ACTIVE.set(probe)
    try:
        with measurement.instrument_decoders():
            await asyncio.to_thread(alias.decode, compiled)
            await asyncio.to_thread(measurement.baseline.bundle, Material(compiled_bundle=compiled))
            await asyncio.to_thread(assets.decode, generated.payload, text_resources(book))
        assert probe.epub_decodes == 2
        assert probe.readings_decodes == 1
        assert probe.epub_decode_ms > 0
        assert probe.readings_decode_ms > 0
        assert epub_storage.decode is original
        assert alias.decode is original
        assert measurement.baseline.decode_epub is original
    finally:
        measurement.ACTIVE.reset(context)
        del sys.modules[alias.__name__]


@pytest.mark.asyncio
async def test_memory_pass_separates_retained_cold_allocations_from_warm_new_allocations() -> None:
    retained: list[bytearray] = []

    async def invoke() -> bytearray:
        if not retained:
            retained.append(bytearray(128 * 1024))
        return bytearray(64 * 1024)

    cold = await measurement.measure(invoke, 1, True)
    warm = await measurement.measure(invoke, 1, True)
    assert cold["peak_python_bytes"] > 192 * 1024
    assert 128 * 1024 <= cold["live_after_response_release_bytes"] < 160 * 1024
    assert warm["peak_python_bytes"] < cold["peak_python_bytes"]
    assert warm["live_after_response_release_bytes"] < 32 * 1024
    assert len(retained[0]) == 128 * 1024


@pytest.mark.asyncio
async def test_frozen_baseline_runs_all_three_flows_and_keeps_historical_blob_counts(
    tmp_path: Path,
) -> None:
    importlib.import_module("app.main")
    engine = create_engine(tmp_path / "measurement.db")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    compiled_reads = 0

    @event.listens_for(engine.sync_engine, "before_cursor_execute")
    def count_reads(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _many: bool,
    ) -> None:
        nonlocal compiled_reads
        projection = statement.lower().split("from", 1)[0]
        compiled_reads += int("select" in projection and "materials.compiled_bundle" in projection)

    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        book, generated, _ = measurement.synthetic("control", measurement.Scale(2, 5, 1, 8))
        fixture = await measurement.publish_fixture(factory, "control", book, generated, {})
        assert fixture.metadata["selected_chapter_codepoints"] == 10
        assert fixture.metadata["selected_chapter_response_token_count"] == 5
        async with factory() as session:
            saved = await measurement.baseline.save_position(
                session,
                fixture.material_id,
                ReadingPositionUpdate(
                    version_id=fixture.version_id,
                    chapter_id=fixture.chapter_id,
                    resource_id=fixture.resource_id,
                    part_index=0,
                    kind="text",
                    offset=0,
                    expected_revision=0,
                ),
            )
            assert saved.revision == 1
        assert compiled_reads == 2
        async with factory() as session:
            response = await measurement.baseline.get_readings(
                session,
                fixture.material_id,
                fixture.version_id,
                fixture.chapter_id,
            )
            assert len(response.resources[0].tokens) == 5
        assert compiled_reads == 3
        async with factory() as session:
            image = await measurement.baseline.illustration_content(
                session,
                fixture.material_id,
                fixture.version_id,
                0,
            )
            assert bytes(image.body).startswith(b"\x89PNG\r\n\x1a\n")
        assert compiled_reads == 4
    finally:
        await engine.dispose()
