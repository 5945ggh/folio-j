"""Synthetic archives exercise atomic publication, safe rendering and local isolation."""

import asyncio
import io
import json
import sqlite3
import threading
import zipfile
import zlib
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException
from support_api import chat_client

from app.services import dictionary_store
from app.services.dictionary_store import DictionaryStore


def archive(records: list[list[object]], *, title: str = "合成词典", version: int = 3) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr(
            "index.json", json.dumps({"title": title, "format": version, "revision": "test-1"})
        )
        package.writestr("term_bank_1.json", json.dumps(records))
    return output.getvalue()


def record(
    term: str, sequence: object = 1, definitions: list[object] | None = None
) -> list[object]:
    return [
        term,
        "アメ",
        "n",
        "",
        0,
        ["合成释义"] if definitions is None else definitions,
        sequence,
        "",
    ]


async def chunks(value: bytes) -> AsyncGenerator[bytes]:
    midpoint = len(value) // 2
    yield value[:midpoint]
    yield value[midpoint:]


@pytest.mark.asyncio
async def test_persists_every_record_safe_tree_and_invalid_sequence(tmp_path: Path) -> None:
    store = DictionaryStore(tmp_path / "dictionary.sqlite3")
    structured: dict[str, object] = {
        "type": "structured-content",
        "content": {
            "tag": "div",
            "content": [
                {"tag": "p", "content": "日本語の定義。"},
                {"tag": "span", "data": {"class": "dfcn"}, "content": "中文释义。"},
                {
                    "tag": "div",
                    "data": {"class": "exam"},
                    "content": [
                        {"tag": "span", "data": {"class": "exjp"}, "content": "雨が降る。"},
                        {"tag": "span", "data": {"class": "excn"}, "content": "下雨。"},
                    ],
                },
                {"tag": "script", "content": "do-not-render"},
                {"tag": "a", "href": "https://invalid.test", "content": "文字链接"},
            ],
        },
    }
    source = archive(
        [
            record("雨", definitions=[structured]),
            record("飴"),
            *[record("雨", sequence=value) for value in [None, -1, "1", 1.5, True]],
            record("あめ", sequence=0),
        ]
    )
    first = await store.import_stream(chunks(source))
    assert first.entry_count == 8 and first.title == "合成词典" and first.ready
    # A fresh object has no process-local dependency on the importing store.
    reopened = DictionaryStore(store.path)
    assert await reopened.status() == first
    entries = await reopened.find_terms(["あめ"])
    assert len(entries) == 8  # hiragana queries recall katakana reading indexes
    assert [entry.sequence for entry in entries] == [1, 1, None, None, None, None, None, 0]
    assert [
        entry.term for entry in await reopened.get_sequences([(first.dictionary_id or "", 1)])
    ] == ["雨", "飴"]
    nodes = entries[0].definitions[0].content
    assert nodes[0].tag == "p"
    assert nodes[1].lang == "zh" and nodes[1].role == "dfcn"
    assert nodes[2].content[0].lang == "ja" and nodes[2].content[1].lang == "zh"
    assert nodes[3].tag == "span" and nodes[3].content[0].text == "文字链接"
    assert "do-not-render" not in entries[0].definitions[0].model_dump_json()
    with sqlite3.connect(store.path) as connection:
        saved = connection.execute(
            "SELECT original, payload FROM entries JOIN definitions "
            "ON definition_id = definitions.id WHERE entries.id = 1"
        ).fetchone()
        metadata = json.loads(saved[0])
        original_definitions = json.loads(zlib.decompress(saved[1]))["source"]
        assert metadata[:5] + [original_definitions] + metadata[5:] == [
            "雨",
            "アメ",
            "n",
            "",
            0,
            [structured],
            1,
            "",
        ]
        assert connection.execute("SELECT count(*) FROM definitions").fetchone()[0] == 2
    assert not await asyncio.to_thread(lambda: list(tmp_path.glob(".dictionary-*")))


@pytest.mark.asyncio
async def test_failed_import_keeps_published_index_and_bounds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = DictionaryStore(tmp_path / "dictionary.sqlite3")
    original = await store.import_stream(chunks(archive([record("雨")])))
    malformed = [b"not a zip", archive([record("雨")], version=2), archive([record("雨"), ["bad"]])]
    for raw in malformed:
        with pytest.raises(HTTPException) as error:
            await store.import_stream(chunks(raw))
        assert error.value.status_code == 422
        assert await store.status() == original
    monkeypatch.setattr(dictionary_store, "MAX_UPLOAD_BYTES", 10)
    with pytest.raises(HTTPException) as oversized:
        await store.import_stream(chunks(b"x" * 11))
    assert oversized.value.status_code == 413
    monkeypatch.setattr(dictionary_store, "MAX_UPLOAD_BYTES", 256 * 1024 * 1024)
    monkeypatch.setattr(dictionary_store, "MAX_BANK_BYTES", 1)
    with pytest.raises(HTTPException):
        await store.import_stream(chunks(archive([record("雨")])))
    assert await store.status() == original
    assert not await asyncio.to_thread(lambda: list(tmp_path.glob(".dictionary-*")))


@pytest.mark.asyncio
async def test_atomic_publish_never_mixes_dictionary_versions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = DictionaryStore(tmp_path / "dictionary.sqlite3")
    first = await store.import_stream(chunks(archive([record("雨"), record("飴")])))
    entered, release = threading.Event(), threading.Event()
    original_build = dictionary_store._build  # pyright: ignore[reportPrivateUsage]

    def paused_build(source: Path, target: Path) -> Any:
        result = original_build(source, target)
        entered.set()
        if not release.wait(timeout=10):
            raise AssertionError("test publisher was not released")
        return result

    monkeypatch.setattr(dictionary_store, "_build", paused_build)
    async with store.snapshot() as old:
        task = asyncio.create_task(
            store.import_stream(chunks(archive([record("新版")], title="新版词典")))
        )
        try:
            assert await asyncio.to_thread(entered.wait, 10)
            assert await store.status() == first
            assert len(await old.find_terms(["雨"])) == 1
        finally:
            release.set()
        second = await task
        assert second.dictionary_id != first.dictionary_id
        assert (await store.status()).title == "新版词典"
        assert [
            entry.term for entry in await old.get_sequences([(first.dictionary_id or "", 1)])
        ] == ["雨", "飴"]
    assert [entry.term for entry in await store.find_terms(["新版"])] == ["新版"]
    assert not await store.find_terms(["雨"])


@pytest.mark.asyncio
async def test_api_isolated_by_database_path_read_only_lookup_and_restart(tmp_path: Path) -> None:
    database = tmp_path / "app.db"
    async with chat_client(database) as (client, _):
        assert (await client.get("/api/dictionary")).json()["ready"] is False
        imported = await client.post(
            "/api/dictionary/import",
            content=archive([record("雨")]),
            headers={"content-type": "application/zip"},
        )
        assert imported.status_code == 200, imported.text
        lookup = await client.post("/api/dictionary/lookup", json={"text": "雨。", "position": 0})
        assert lookup.status_code == 200, lookup.text
        match = lookup.json()["matches"][0]
        assert (match["term"], match["start"], match["end"], match["surface"]) == ("雨", 0, 1, "雨")
        invalid = await client.post("/api/dictionary/lookup", json={"text": "雨", "position": 2})
        assert invalid.status_code == 422
        invalid_selection = await client.post(
            "/api/dictionary/lookup", json={"text": "雨", "selection_start": 0}
        )
        assert invalid_selection.status_code == 422
        with sqlite3.connect(database) as connection:
            for table in ["runs", "segments", "analyses", "reading_positions", "material_usage"]:
                assert connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 0
    async with chat_client(database) as (client, _):
        assert (await client.get("/api/dictionary")).json() == imported.json()
    async with chat_client(tmp_path / "other.db") as (client, _):
        assert (await client.get("/api/dictionary")).json()["ready"] is False
        assert (
            await client.post("/api/dictionary/lookup", json={"text": "雨", "position": 0})
        ).json() == {"matches": []}


@pytest.mark.asyncio
async def test_corrupt_index_can_be_reimported(tmp_path: Path) -> None:
    path = tmp_path / "dictionary.sqlite3"
    path.write_bytes(b"broken cache")
    store = DictionaryStore(path)
    assert not (await store.status()).ready
    assert not await store.find_terms(["雨"])
    assert (await store.import_stream(chunks(archive([record("雨")])))).ready


@pytest.mark.asyncio
async def test_metadata_queries_decode_only_selected_shared_definitions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = DictionaryStore(tmp_path / "dictionary.sqlite3")
    await store.import_stream(
        chunks(
            archive(
                [
                    record(f"合成{i}", sequence=i, definitions=["日本語の例文。" * 100])
                    for i in range(256)
                ]
            )
        )
    )
    with sqlite3.connect(store.path) as connection:
        assert connection.execute("SELECT count(*) FROM entries").fetchone()[0] == 256
        assert connection.execute("SELECT count(*) FROM definitions").fetchone()[0] == 1
    calls: list[int] = []
    decode = dictionary_store._decode_definitions  # pyright: ignore[reportPrivateUsage]

    def counted(
        rows: list[tuple[str, bytes]], budget: int
    ) -> tuple[dict[str, tuple[dictionary_store.DictionaryNode, ...]], int]:
        calls.append(len(rows))
        return decode(rows, budget)

    monkeypatch.setattr(dictionary_store, "_decode_definitions", counted)
    async with store.snapshot() as snapshot:
        entries = await snapshot.find_terms([f"合成{i}" for i in range(256)])
        assert not calls and all(not entry.definitions for entry in entries)
        selected = await snapshot.load_definitions(entries[:2])
        assert calls == [1] and selected[0].definitions
        assert selected[0].definitions is selected[1].definitions
        await snapshot.load_definitions(entries[2:])
        assert calls == [1]


@pytest.mark.asyncio
async def test_obsolete_index_is_retained_until_successful_reimport(tmp_path: Path) -> None:
    store = DictionaryStore(tmp_path / "dictionary.sqlite3")
    raw = archive([record("雨")])
    original = await store.import_stream(chunks(raw))
    with sqlite3.connect(store.path) as connection:
        connection.execute("UPDATE metadata SET version = 'old'")
    assert not (await store.status()).ready
    assert not await store.find_terms(["雨"])
    with pytest.raises(HTTPException):
        await store.import_stream(chunks(b"invalid"))
    with sqlite3.connect(store.path) as connection:
        assert connection.execute("SELECT count(*) FROM entries").fetchone()[0] == 1
        assert connection.execute("SELECT version FROM metadata").fetchone()[0] == "old"
    assert await store.import_stream(chunks(raw)) == original


@pytest.mark.asyncio
async def test_lookup_api_accepts_direct_text_and_rejects_half_selection(tmp_path: Path) -> None:
    async with chat_client(tmp_path / "direct.db") as (client, _):
        imported = await client.post(
            "/api/dictionary/import", content=archive([record("待ち合わせる"), record("待ち")])
        )
        assert imported.status_code == 200
        response = await client.post("/api/dictionary/lookup", json={"text": "待ち合わせる"})
        assert response.status_code == 200, response.text
        assert [
            (item["term"], item["start"], item["end"]) for item in response.json()["matches"]
        ] == [("待ち合わせる", 0, 6)]
        for body in [{"selection_start": 0}, {"selection_end": 6}]:
            rejected = await client.post(
                "/api/dictionary/lookup", json={"text": "待ち合わせる", **body}
            )
            assert rejected.status_code == 422


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "evidence",
    [
        {},
        {"reading": "タベ"},
        {"dictionary_form": "食べる"},
        {"normalized_form": "食べる", "pos": ["動詞"]},
        {
            "reading": "タベ",
            "dictionary_form": "食べる",
            "normalized_form": "食べる",
            "pos": ["動詞", "一般", "*", "*", "下一段-バ行", "連用形-一般"],
            "is_oov": False,
        },
    ],
)
async def test_lookup_api_accepts_independent_optional_token_evidence(
    tmp_path: Path, evidence: dict[str, object]
) -> None:
    async with chat_client(tmp_path / "hints.db") as (client, _):
        assert (
            await client.post("/api/dictionary/import", content=archive([record("食べる")]))
        ).status_code == 200
        response = await client.post(
            "/api/dictionary/lookup",
            json={
                "text": "食べました",
                "position": 3,
                "tokens": [{"start": 0, "end": 2, "surface": "食べ", **evidence}],
            },
        )
        assert response.status_code == 200, response.text
        assert any(
            (item["term"], item["start"], item["end"]) == ("食べる", 0, 5)
            for item in response.json()["matches"]
        )
