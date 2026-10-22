"""Statistics API keeps input identities, visibility and instance isolation intact."""

import asyncio
import sqlite3
import threading
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import pytest
from httpx import AsyncClient
from test_chat_api import chat_client
from test_materials import compiled

from app.nlp.contracts import DecodedReadings, TextResource
from app.nlp.statistics import LexicalStatistics, TextStatistics
from app.services import statistics


async def seed(client: AsyncClient, raw: bytes = b"book") -> tuple[str, dict[str, Any]]:
    source = (await client.post("/api/sources", json={"title": "本棚"})).json()["id"]
    result = await client.post(
        f"/api/sources/{source}/materials",
        content=raw,
        headers={"content-type": "application/epub+zip"},
    )
    assert result.status_code == 200, result.text
    return source, result.json()["material"]


def durable_state(database: Path) -> list[tuple[Any, ...]]:
    with sqlite3.connect(database) as connection:
        return [
            (table, *connection.execute(f"SELECT count(*) FROM {table}").fetchone())
            for table in (
                "runs",
                "chat_jobs",
                "reading_positions",
                "material_usage",
                "material_readings_generations",
            )
        ]


@pytest.mark.asyncio
async def test_statistics_cache_is_read_only_and_ignores_presentation_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    original_text, original_lexical = statistics.compute_text, statistics.compute_lexical
    calls = {"text": 0, "lexical": 0}

    def text(inputs: Sequence[TextResource]) -> TextStatistics:
        calls["text"] += 1
        return original_text(inputs)

    def lexical(inputs: Sequence[TextResource], decoded: DecodedReadings) -> LexicalStatistics:
        calls["lexical"] += 1
        return original_lexical(inputs, decoded)

    monkeypatch.setattr(statistics, "compute_text", text)
    monkeypatch.setattr(statistics, "compute_lexical", lexical)
    database = tmp_path / "statistics.db"
    async with chat_client(database) as (client, _app):
        _, material = await seed(client)
        url = f"/api/materials/{material['id']}"
        params = {"version_id": material["version_id"]}
        before = durable_state(database)
        first = await client.get(url + "/statistics", params=params)
        assert first.status_code == 200, first.text
        result = first.json()
        assert result["material_id"] == material["id"]
        assert result["scope"] == "unique_resources"
        assert result["text"]["character_count"] == 3
        assert result["text"]["resource_count"] == 1
        assert result["text"]["unique_kanji_count"] == 3
        assert result["generation_id"]
        assert result["lexical"]["counted_token_count"] > 0
        assert result["analysis_configuration"]
        assert len(result["lexical"]["coverage"]) <= 512
        assert durable_state(database) == before
        result["text"]["character_count"] = 999  # Caller mutation cannot poison bytes cache.
        assert (await client.get(url + "/statistics", params=params)).json() == first.json()
        edited = await client.patch(
            url + "/metadata", json={"title": "新书名", "expected_revision": 0}
        )
        assert edited.status_code == 200, edited.text
        assert (await client.get(url + "/statistics", params=params)).json() == first.json()
        assert calls == {"text": 1, "lexical": 1}
        monkeypatch.setattr(statistics, "TEXT_RULE_VERSION", "text-next")
        assert (await client.get(url + "/statistics", params=params)).status_code == 200
        assert calls == {"text": 2, "lexical": 1}
        monkeypatch.setattr(statistics, "LEXICAL_RULE_VERSION", "lexical-next")
        assert (await client.get(url + "/statistics", params=params)).status_code == 200
        assert calls == {"text": 2, "lexical": 2}


@pytest.mark.asyncio
async def test_statistics_generation_ownership_and_text_without_current_analysis(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    database = tmp_path / "ownership.db"
    async with chat_client(database) as (client, _app):
        _, material = await seed(client)
        url = f"/api/materials/{material['id']}/statistics"
        params = {"version_id": material["version_id"]}
        original = (await client.get(url, params=params)).json()
        _, other = await seed(client, b"other")
        other_url = f"/api/materials/{other['id']}/statistics"
        outside = await client.get(
            other_url,
            params={"version_id": other["version_id"], "generation_id": original["generation_id"]},
        )
        assert outside.status_code == 404
        assert (await client.get(url, params={"version_id": "wrong"})).status_code == 409
        assert (
            await client.get(url, params={**params, "generation_id": "missing"})
        ).status_code == 404
        with sqlite3.connect(database) as connection:
            connection.execute(
                "DELETE FROM material_readings_current WHERE material_id=?", (material["id"],)
            )
        before = durable_state(database)
        no_current = await client.get(url, params=params)
        assert no_current.status_code == 200
        result = no_current.json()
        assert result["text"] == original["text"]
        assert result["generation_id"] is None
        assert result["lexical"] is None and result["analysis_configuration"] is None
        old = await client.get(url, params={**params, "generation_id": original["generation_id"]})
        assert old.status_code == 200 and old.json() == original
        assert durable_state(database) == before


@pytest.mark.asyncio
@pytest.mark.parametrize("warm", [False, True])
@pytest.mark.parametrize("target", ["sources", "materials"])
async def test_source_deletion_blocks_cached_and_inflight_statistics(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, warm: bool, target: str
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    started, release = threading.Event(), threading.Event()
    original = statistics._text_result  # pyright: ignore[reportPrivateUsage]

    def delayed(bundle: bytes) -> bytes:
        started.set()
        assert release.wait(5)
        return original(bundle)

    async with chat_client(tmp_path / "delete.db") as (client, _app):
        source, material = await seed(client)
        url = f"/api/materials/{material['id']}/statistics"
        params = {"version_id": material["version_id"]}
        if warm:
            assert (await client.get(url, params=params)).status_code == 200
            assert (
                await client.delete(
                    f"/api/{target}/{source if target == 'sources' else material['id']}"
                )
            ).status_code == 204
            assert (await client.get(url, params=params)).status_code == 404
        else:
            monkeypatch.setattr(statistics, "_text_result", delayed)
            pending = asyncio.create_task(client.get(url, params=params))
            assert await asyncio.to_thread(started.wait, 5)
            try:
                assert (
                    await client.delete(
                        f"/api/{target}/{source if target == 'sources' else material['id']}"
                    )
                ).status_code == 204
            finally:
                release.set()
            assert (await pending).status_code == 404


@pytest.mark.asyncio
async def test_generation_switch_during_compute_keeps_old_identity_and_reuses_text(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.nlp import tokenization

    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    started, release = threading.Event(), threading.Event()
    original = statistics._lexical_result  # pyright: ignore[reportPrivateUsage]
    text_compute = statistics.compute_text
    text_calls = 0
    lexical_calls = 0

    def text(inputs: Sequence[TextResource]) -> TextStatistics:
        nonlocal text_calls
        text_calls += 1
        return text_compute(inputs)

    def delayed(bundle: bytes, payload: bytes, configuration: str) -> bytes:
        nonlocal lexical_calls
        lexical_calls += 1
        if lexical_calls == 1:
            started.set()
            assert release.wait(5)
        return original(bundle, payload, configuration)

    monkeypatch.setattr(statistics, "compute_text", text)
    monkeypatch.setattr(statistics, "_lexical_result", delayed)
    async with chat_client(tmp_path / "generation.db") as (client, _app):
        _, material = await seed(client)
        base = f"/api/materials/{material['id']}"
        params = {"version_id": material["version_id"]}
        initial = (await client.post(base + "/readings/prepare", json=params)).json()[
            "generation_id"
        ]
        pending = asyncio.create_task(client.get(base + "/statistics", params=params))
        assert await asyncio.to_thread(started.wait, 5)
        try:
            monkeypatch.setattr(tokenization, "FORMAT_VERSION", "statistics-second")
            prepared = await client.post(base + "/readings/prepare", json={**params, "force": True})
            assert prepared.status_code == 200, prepared.text
            new_generation = prepared.json()["generation_id"]
            assert new_generation != initial
        finally:
            release.set()
        first = await pending
        assert first.status_code == 200, first.text
        assert first.json()["generation_id"] == initial
        newer = await client.get(base + "/statistics", params=params)
        assert newer.status_code == 200, newer.text
        assert newer.json()["generation_id"] == new_generation
        old = await client.get(base + "/statistics", params={**params, "generation_id": initial})
        assert old.status_code == 200 and old.json() == first.json()
        assert text_calls == 1 and lexical_calls == 2


@pytest.mark.asyncio
async def test_broken_asset_fails_without_caching_and_can_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    database = tmp_path / "broken.db"
    async with chat_client(database) as (client, _app):
        _, material = await seed(client)
        with sqlite3.connect(database) as connection:
            generation_id, payload = connection.execute(
                "SELECT id,payload FROM material_readings_generations WHERE material_id=?",
                (material["id"],),
            ).fetchone()
            connection.execute(
                "UPDATE material_readings_generations SET payload=? WHERE id=?",
                (b"bad", generation_id),
            )
        url = f"/api/materials/{material['id']}/statistics"
        params = {"version_id": material["version_id"]}
        assert (await client.get(url, params=params)).status_code == 503
        with sqlite3.connect(database) as connection:
            connection.execute(
                "UPDATE material_readings_generations SET payload=? WHERE id=?",
                (payload, generation_id),
            )
        assert (await client.get(url, params=params)).status_code == 200


@pytest.mark.asyncio
async def test_distinct_applications_and_restart_do_not_share_cached_materials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    original = statistics.compute_text
    calls = 0

    def text(inputs: Sequence[TextResource]) -> TextStatistics:
        nonlocal calls
        calls += 1
        return original(inputs)

    monkeypatch.setattr(statistics, "compute_text", text)
    database, copied = tmp_path / "one.db", tmp_path / "two.db"
    async with chat_client(database) as (client, _app):
        _, material = await seed(client)
        url = f"/api/materials/{material['id']}/statistics"
        params = {"version_id": material["version_id"]}
        with sqlite3.connect(database) as source, sqlite3.connect(copied) as destination:
            source.backup(destination)
        first = await client.get(url, params=params)
        assert first.status_code == 200
        async with chat_client(copied) as (other, _other_app):
            assert (await other.get(url, params=params)).json() == first.json()
        assert calls == 2
        assert (await client.get(url, params=params)).json() == first.json()
        assert calls == 2
    async with chat_client(database) as (restarted, _app):
        assert (await restarted.get(url, params=params)).json() == first.json()
    assert calls == 3
