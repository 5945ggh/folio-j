"""Offline vocabulary API acceptance: saved assets, navigation and identity gates."""

import asyncio
import hashlib
import json
import sqlite3
import threading
import zlib
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any, NoReturn

import pytest
from test_chat_api import chat_client
from test_material_statistics import seed
from test_materials import compiled
from test_statistics import characters, source
from test_vocabulary import vocabulary_sample

from app.epub_schemas import CompiledBook
from app.nlp.contracts import DecodedReadings, TextResource
from app.nlp.tokenization import GeneratedReadings
from app.nlp.vocabulary import VocabularySort
from app.services import vocabulary


def fixture_book(empty: bool = False) -> tuple[CompiledBook, DecodedReadings]:
    if empty:
        inputs = [source("plain-text", "。！？ \n")]
        decoded = characters(inputs)
    else:
        inputs, decoded = vocabulary_sample()
    resource = inputs[0]
    base = compiled(b"")
    book_resource = base.resources[0].model_copy(
        update={
            "id": resource.resource_id,
            "text": resource.text,
            "text_sha256": resource.text_sha256,
        }
    )
    part = (
        base.chapters[0]
        .parts[0]
        .model_copy(
            update={
                "resource_id": resource.resource_id,
                "end": len(resource.text),
                "html": f"<p>{resource.text}</p>",
            }
        )
    )
    first = base.chapters[0].model_copy(update={"parts": [part]})
    second = first.model_copy(
        update={"id": "repeated-chapter", "parts": [part.model_copy(update={"spine_index": 1})]}
    )
    return base.model_copy(
        update={"resources": [book_resource, book_resource], "chapters": [first, second]}
    ), decoded


def install_fixture(monkeypatch: pytest.MonkeyPatch, *, empty: bool = False) -> CompiledBook:
    book, decoded = fixture_book(empty)

    def compile_book(_data: bytes) -> CompiledBook:
        return book.model_copy(deep=True)

    async def build(resources: Sequence[TextResource]) -> GeneratedReadings:
        return saved_asset(resources, decoded)

    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compile_book)
    monkeypatch.setattr("app.services.readings.build", build)
    return book


def saved_asset(
    resources: Sequence[TextResource], decoded: DecodedReadings, configuration: str = "{}"
) -> GeneratedReadings:
    asset = DecodedReadings(
        configuration=configuration,
        resources=[decoded.resources[0].model_copy(deep=True) for _ in resources],
    )
    raw = json.dumps(asset.model_dump(), ensure_ascii=False, sort_keys=True).encode()
    return GeneratedReadings(
        configuration=asset.configuration,
        asset_sha256=hashlib.sha256(raw).hexdigest(),
        token_count=sum(len(item.tokens) for item in asset.resources),
        payload=zlib.compress(raw),
    )


def saved_reading_state(database: Path) -> list[tuple[str, list[tuple[Any, ...]]]]:
    with sqlite3.connect(database) as connection:
        return [
            (table, connection.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall())
            for table in (
                "runs",
                "chat_jobs",
                "reading_positions",
                "material_usage",
                "material_readings_generations",
                "material_readings_current",
            )
        ]


@pytest.mark.asyncio
async def test_saved_vocabulary_and_occurrences_are_read_only_and_navigable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    book = install_fixture(monkeypatch)
    database = tmp_path / "vocabulary.db"
    async with chat_client(database) as (client, _app):
        _, material = await seed(client)
        base = f"/api/materials/{material['id']}"
        params = {"version_id": material["version_id"]}

        def unexpected(*_args: object, **_kwargs: object) -> NoReturn:
            raise AssertionError("GET must only use the saved analysis asset")

        monkeypatch.setattr("app.services.readings.build", unexpected)
        monkeypatch.setattr("app.nlp.tokenization.generate", unexpected)
        before = saved_reading_state(database)
        response = await client.get(base + "/vocabulary", params=params)
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["status"] == "ready"
        assert result["scope"] == "unique_resources"
        assert result["material_id"] == material["id"]
        assert result["version_id"] == material["version_id"]
        assert result["generation_id"] and result["analysis_configuration"] == "{}"
        assert result["total"] == 4
        assert [(item["word"], item["frequency"]) for item in result["items"]] == [
            ("猫", 2),
            ("生", 2),
            ("生きる", 2),
            ("犬", 1),
        ]
        assert set(result["available_pos"]) == {"名詞", "形状詞", "動詞"}
        stats = await client.get(base + "/statistics", params=params)
        assert stats.status_code == 200, stats.text
        assert (
            sum(item["frequency"] for item in result["items"])
            == stats.json()["lexical"]["counted_token_count"]
        )
        assert stats.json()["generation_id"] == result["generation_id"]
        occurrences = await client.get(
            base + "/vocabulary/occurrences",
            params={**params, "generation_id": result["generation_id"], "word": "生きる"},
        )
        assert occurrences.status_code == 200, occurrences.text
        places = occurrences.json()
        assert places["total"] == 2
        assert places["generation_id"] == result["generation_id"]
        for item in places["items"]:
            assert item["chapter_id"] == "c1" and item["spine_index"] == 0
            chapter = await client.get(base + f"/chapters/{item['chapter_id']}")
            assert chapter.status_code == 200, chapter.text
            part = chapter.json()["parts"][item["part_index"]]
            assert part["resource_id"] == item["resource_id"]
            assert part["start"] <= item["start"] < item["end"] <= part["end"]
            text = book.resources[0].text
            assert text[item["start"] : item["end"]] == item["match"]
            assert item["text_sha256"] == book.resources[0].text_sha256
            assert item["before"] + item["match"] + item["after"] in text
            assert item["parts_of_speech"][0] == "動詞"
        assert saved_reading_state(database) == before


@pytest.mark.asyncio
@pytest.mark.parametrize("presentation", ["cross-chapter", "same-chapter-parts", "later-repeat"])
async def test_occurrence_jump_requires_a_complete_contiguous_presentation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, presentation: str
) -> None:
    book = install_fixture(monkeypatch)
    first = book.chapters[0]
    complete = first.parts[0]
    left = complete.model_copy(update={"end": 6})
    right = complete.model_copy(update={"start": 6})
    if presentation == "cross-chapter":
        book.chapters[:] = [
            first.model_copy(update={"parts": [left]}),
            first.model_copy(update={"id": "second", "parts": [right]}),
        ]
    elif presentation == "same-chapter-parts":
        book.chapters[:] = [first.model_copy(update={"parts": [left, right]})]
    else:
        book.chapters[0] = first.model_copy(update={"parts": [left]})
    database = tmp_path / "presentation.db"
    async with chat_client(database) as (client, _app):
        _, material = await seed(client)
        base = f"/api/materials/{material['id']}"
        params = {"version_id": material["version_id"]}
        generation = (await client.get(base + "/vocabulary", params=params)).json()["generation_id"]
        response = await client.get(
            base + "/vocabulary/occurrences",
            params={
                **params,
                "generation_id": generation,
                "word": "生きる",
            },
        )
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["total"] == 2
        crossing = result["items"][0]
        assert crossing["match"] == "生きた" and (crossing["start"], crossing["end"]) == (4, 7)
        if presentation == "cross-chapter":
            assert all(
                crossing[field] is None
                for field in (
                    "chapter_id",
                    "chapter_title",
                    "part_index",
                    "spine_index",
                )
            )
        else:
            assert crossing["chapter_id"] == (
                "c1" if presentation == "same-chapter-parts" else "repeated-chapter"
            )
            assert crossing["part_index"] == 0
            assert crossing["spine_index"] == (0 if presentation == "same-chapter-parts" else 1)


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint", ["vocabulary", "vocabulary/occurrences"])
async def test_broken_vocabulary_asset_can_retry_without_a_poisoned_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, endpoint: str
) -> None:
    install_fixture(monkeypatch)
    database = tmp_path / "corrupt.db"
    async with chat_client(database) as (client, _app):
        _, material = await seed(client)
        with sqlite3.connect(database) as connection:
            generation, payload = connection.execute(
                "SELECT id,payload FROM material_readings_generations WHERE material_id=?",
                (material["id"],),
            ).fetchone()
            connection.execute(
                "UPDATE material_readings_generations SET payload=? WHERE id=?",
                (b"bad", generation),
            )
        url = f"/api/materials/{material['id']}/{endpoint}"
        params = {"version_id": material["version_id"], "generation_id": generation, "word": "猫"}
        assert (await client.get(url, params=params)).status_code == 503
        with sqlite3.connect(database) as connection:
            connection.execute(
                "UPDATE material_readings_generations SET payload=? WHERE id=?",
                (payload, generation),
            )
        response = await client.get(url, params=params)
        assert response.status_code == 200, response.text


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint", ["vocabulary", "vocabulary/occurrences"])
@pytest.mark.parametrize("target", ["sources", "materials"])
@pytest.mark.parametrize("warm", [False, True])
async def test_deletion_blocks_cached_and_inflight_vocabulary_queries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, endpoint: str, target: str, warm: bool
) -> None:
    install_fixture(monkeypatch)
    database = tmp_path / "delete.db"
    started, release = threading.Event(), threading.Event()
    worker = "_occurrences_result" if endpoint.endswith("occurrences") else "_vocabulary_result"
    original: Callable[..., bytes] = getattr(vocabulary, worker)

    def delayed(*args: Any, **kwargs: Any) -> bytes:
        started.set()
        assert release.wait(5)
        return original(*args, **kwargs)

    async with chat_client(database) as (client, _app):
        source_id, material = await seed(client)
        with sqlite3.connect(database) as connection:
            generation = connection.execute(
                "SELECT generation_id FROM material_readings_current WHERE material_id=?",
                (material["id"],),
            ).fetchone()[0]
        url = f"/api/materials/{material['id']}/{endpoint}"
        params = {"version_id": material["version_id"], "generation_id": generation, "word": "猫"}
        deletion_url = f"/api/{target}/{source_id if target == 'sources' else material['id']}"
        if warm:
            initial = await client.get(url, params=params)
            assert initial.status_code == 200, initial.text
            assert (await client.delete(deletion_url)).status_code == 204
            assert (await client.get(url, params=params)).status_code == 404
        else:
            monkeypatch.setattr(vocabulary, worker, delayed)
            pending = asyncio.create_task(client.get(url, params=params))
            assert await asyncio.to_thread(started.wait, 5)
            try:
                assert (await client.delete(deletion_url)).status_code == 204
            finally:
                release.set()
            assert (await pending).status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint", ["vocabulary", "vocabulary/occurrences"])
async def test_material_version_is_rechecked_after_inflight_vocabulary_compute(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, endpoint: str
) -> None:
    install_fixture(monkeypatch)
    database = tmp_path / "version.db"
    started, release = threading.Event(), threading.Event()
    worker = "_occurrences_result" if endpoint.endswith("occurrences") else "_vocabulary_result"
    original: Callable[..., bytes] = getattr(vocabulary, worker)

    def delayed(*args: Any, **kwargs: Any) -> bytes:
        started.set()
        assert release.wait(5)
        return original(*args, **kwargs)

    async with chat_client(database) as (client, _app):
        _, material = await seed(client)
        with sqlite3.connect(database) as connection:
            generation = connection.execute(
                "SELECT generation_id FROM material_readings_current WHERE material_id=?",
                (material["id"],),
            ).fetchone()[0]
        monkeypatch.setattr(vocabulary, worker, delayed)
        pending = asyncio.create_task(
            client.get(
                f"/api/materials/{material['id']}/{endpoint}",
                params={
                    "version_id": material["version_id"],
                    "generation_id": generation,
                    "word": "猫",
                },
            )
        )
        assert await asyncio.to_thread(started.wait, 5)
        try:
            with sqlite3.connect(database) as connection:
                connection.execute(
                    "UPDATE materials SET version_id='changed' WHERE id=?", (material["id"],)
                )
        finally:
            release.set()
        assert (await pending).status_code == 409


@pytest.mark.asyncio
async def test_inflight_list_and_expanded_occurrences_keep_the_same_generation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_fixture(monkeypatch)
    database = tmp_path / "generation.db"
    started, release = threading.Event(), threading.Event()
    original = vocabulary._vocabulary_result  # pyright: ignore[reportPrivateUsage]
    calls = 0

    def delayed(
        bundle: bytes,
        payload: bytes,
        configuration: str,
        query: str,
        pos: str | None,
        sort: VocabularySort,
        offset: int,
        limit: int,
    ) -> bytes:
        nonlocal calls
        calls += 1
        if calls == 1:
            started.set()
            assert release.wait(5)
        return original(bundle, payload, configuration, query, pos, sort, offset, limit)

    async with chat_client(database) as (client, _app):
        _, material = await seed(client)
        base = f"/api/materials/{material['id']}"
        params = {"version_id": material["version_id"]}
        old_generation = (await client.post(base + "/readings/prepare", json=params)).json()[
            "generation_id"
        ]
        monkeypatch.setattr(vocabulary, "_vocabulary_result", delayed)
        pending = asyncio.create_task(client.get(base + "/vocabulary", params=params))
        assert await asyncio.to_thread(started.wait, 5)
        _, changed = vocabulary_sample()
        for record in changed.resources[0].tokens:
            if record.surface == "猫":
                record.dictionary_form = "変更後"

        async def build_next(resources: Sequence[TextResource]) -> GeneratedReadings:
            return saved_asset(resources, changed, '{"test_generation":2}')

        monkeypatch.setattr("app.services.readings.build", build_next)
        try:
            rebuilt = await client.post(base + "/readings/prepare", json={**params, "force": True})
            assert rebuilt.status_code == 200, rebuilt.text
        finally:
            release.set()
        old = await pending
        assert old.status_code == 200, old.text
        assert old.json()["generation_id"] == old_generation
        assert "猫" in [item["word"] for item in old.json()["items"]]
        current = await client.get(base + "/vocabulary", params=params)
        assert current.status_code == 200, current.text
        assert current.json()["generation_id"] == rebuilt.json()["generation_id"] != old_generation
        assert "猫" not in [item["word"] for item in current.json()["items"]]
        historical = await client.get(
            base + "/vocabulary", params={**params, "generation_id": old_generation}
        )
        assert historical.status_code == 200 and historical.json() == old.json()
        for generation, expected in ((old_generation, 2), (rebuilt.json()["generation_id"], 0)):
            places = await client.get(
                base + "/vocabulary/occurrences",
                params={
                    **params,
                    "generation_id": generation,
                    "word": "猫",
                },
            )
            assert places.status_code == 200, places.text
            assert places.json()["generation_id"] == generation
            assert places.json()["total"] == expected


@pytest.mark.asyncio
async def test_vocabulary_query_filters_pages_and_parameter_validation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_fixture(monkeypatch)
    async with chat_client(tmp_path / "query.db") as (client, _app):
        _, material = await seed(client)
        url = f"/api/materials/{material['id']}/vocabulary"
        params = {"version_id": material["version_id"]}
        result = await client.get(url, params={**params, "q": "イキタ"})
        assert result.status_code == 200, result.text
        assert [(item["word"], item["frequency"]) for item in result.json()["items"]] == [
            ("生きる", 2)
        ]
        nouns = await client.get(url, params={**params, "pos": "名詞", "sort": "frequency_asc"})
        assert [(item["word"], item["frequency"]) for item in nouns.json()["items"]] == [
            ("犬", 1),
            ("生", 1),
            ("猫", 2),
        ]
        hidden_reading = await client.get(url, params={**params, "pos": "名詞", "q": "ナマ"})
        assert hidden_reading.json()["total"] == 0
        first = await client.get(url, params={**params, "limit": 2})
        second = await client.get(url, params={**params, "limit": 2, "offset": 2})
        assert first.json()["total"] == second.json()["total"] == 4
        assert [item["word"] for item in first.json()["items"] + second.json()["items"]] == [
            "猫",
            "生",
            "生きる",
            "犬",
        ]
        generation = result.json()["generation_id"]
        for changes in ({"limit": 0}, {"limit": 101}, {"offset": -1}, {"sort": "word"}):
            assert (await client.get(url, params={**params, **changes})).status_code == 422
        assert (await client.get(url)).status_code == 422
        for changes in ({"generation_id": "missing"}, {"version_id": "wrong"}):
            response = await client.get(url, params={**params, **changes})
            assert response.status_code == (409 if "version_id" in changes else 404)
        assert (
            await client.get(url + "/occurrences", params={**params, "word": "猫"})
        ).status_code == 422
        selected = await client.get(
            url + "/occurrences",
            params={**params, "generation_id": generation, "word": "生", "pos": "形状詞"},
        )
        assert selected.status_code == 200, selected.text
        assert selected.json()["total"] == 1
        assert selected.json()["items"][0]["reading"] == "ナマ"
        assert selected.json()["items"][0]["is_oov"]


@pytest.mark.asyncio
async def test_missing_current_generation_differs_from_analyzed_empty_vocabulary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_fixture(monkeypatch, empty=True)
    database = tmp_path / "empty.db"
    async with chat_client(database) as (client, _app):
        _, material = await seed(client)
        url = f"/api/materials/{material['id']}/vocabulary"
        params = {"version_id": material["version_id"]}
        empty = await client.get(url, params=params)
        assert empty.status_code == 200, empty.text
        result = empty.json()
        assert result["status"] == "ready" and result["generation_id"]
        assert result["total"] == 0 and result["items"] == []
        _, other = await seed(client, b"another")
        for suffix in ("", "/occurrences"):
            response = await client.get(
                f"/api/materials/{other['id']}/vocabulary{suffix}",
                params={
                    "version_id": other["version_id"],
                    "generation_id": result["generation_id"],
                    "word": "猫",
                },
            )
            assert response.status_code == 404
        with sqlite3.connect(database) as connection:
            connection.execute(
                "DELETE FROM material_readings_current WHERE material_id=?", (material["id"],)
            )
        before = saved_reading_state(database)
        missing = await client.get(url, params=params)
        assert missing.status_code == 200, missing.text
        absent = missing.json()
        assert absent["status"] == "unavailable"
        assert absent["generation_id"] is None and absent["analysis_configuration"] is None
        assert absent["total"] == 0 and absent["items"] == []
        historical = await client.get(
            url, params={**params, "generation_id": result["generation_id"]}
        )
        assert historical.status_code == 200 and historical.json() == result
        assert saved_reading_state(database) == before
