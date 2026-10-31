"""Library installation, explicit activation and retained single-index compatibility."""

import asyncio
import threading
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException
from support_api import chat_client
from test_dictionary_store import archive, chunks, record, seed_legacy

from app.dictionary_schemas import DictionaryLookupRequest
from app.services import dictionary_store
from app.services.dictionary_lookup import lookup
from app.services.dictionary_store import DictionarySnapshot, DictionaryStore


@pytest.mark.asyncio
async def test_library_api_installs_once_and_persists_explicit_selection(tmp_path: Path) -> None:
    database = tmp_path / "app.db"
    first_raw = archive([record("雨")], title="同名词典")
    second_raw = archive([record("猫")], title="同名词典")
    async with chat_client(database) as (client, _):
        assert (await client.get("/api/dictionary/library")).json() == {
            "dictionaries": [],
            "active_dictionary_id": None,
        }
        first = await client.post("/api/dictionary/library/import", content=first_raw)
        assert first.status_code == 200, first.text
        first_id = first.json()["dictionary_id"]
        assert first.json()["already_installed"] is False
        assert first.json()["library"]["active_dictionary_id"] == first_id
        second = await client.post("/api/dictionary/library/import", content=second_raw)
        second_id = second.json()["dictionary_id"]
        assert first_id != second_id
        library = second.json()["library"]
        assert len(library["dictionaries"]) == 2
        assert library["active_dictionary_id"] == first_id
        duplicate = await client.post("/api/dictionary/library/import", content=second_raw)
        assert duplicate.json() == {
            "library": library,
            "dictionary_id": second_id,
            "already_installed": True,
        }
        invalid = await client.put(
            "/api/dictionary/library/selection", json={"dictionary_id": "uninstalled"}
        )
        assert invalid.status_code == 422
        assert (await client.get("/api/dictionary/library")).json() == library
        selected = await client.put(
            "/api/dictionary/library/selection", json={"dictionary_id": second_id}
        )
        assert selected.status_code == 200, selected.text
        assert selected.json()["active_dictionary_id"] == second_id
        assert (await client.get("/api/dictionary")).json()["dictionary_id"] == second_id
        assert (await client.post("/api/dictionary/lookup", json={"text": "雨"})).json() == {
            "matches": []
        }
        assert (await client.post("/api/dictionary/lookup", json={"text": "猫"})).json()["matches"]
    async with chat_client(database) as (client, _):
        assert (await client.get("/api/dictionary/library")).json() == selected.json()
        # The legacy endpoint still installs and explicitly activates its upload.
        legacy = await client.post("/api/dictionary/import", content=first_raw)
        assert legacy.json()["dictionary_id"] == first_id
        retained = (await client.get("/api/dictionary/library")).json()
        assert len(retained["dictionaries"]) == 2
        assert retained["active_dictionary_id"] == first_id
    async with chat_client(tmp_path / "separate.db") as (client, _):
        assert (await client.get("/api/dictionary/library")).json()["dictionaries"] == []


@pytest.mark.asyncio
async def test_existing_dictionary_remains_in_place_without_reimport(tmp_path: Path) -> None:
    store = DictionaryStore(tmp_path / "app.db.dictionary.sqlite3")
    raw = archive([record("雨")], title="原有明镜")
    original = await asyncio.to_thread(seed_legacy, store, raw)
    original_bytes = store.path.read_bytes()
    assert await store.status() == original
    assert (await store.library()).active_dictionary_id == original.dictionary_id
    assert not store.catalog_path.exists()  # Opening a reader is read-only.
    async with store.snapshot() as old:
        newer = await store.import_library_stream(chunks(archive([record("猫")], title="另一部")))
        assert newer.library.active_dictionary_id == original.dictionary_id
        assert len(newer.library.dictionaries) == 2
        await store.select(newer.dictionary_id)
        assert [item.term for item in await old.find_terms(["雨"])] == ["雨"]
    assert store.path.read_bytes() == original_bytes
    await store.select(original.dictionary_id or "")
    assert await DictionaryStore(store.path).status() == original
    duplicate = await store.import_library_stream(chunks(raw))
    assert duplicate.already_installed
    assert len(duplicate.library.dictionaries) == 2
    assert store.path.read_bytes() == original_bytes


@pytest.mark.asyncio
async def test_selection_during_build_is_immediate_and_late_import_keeps_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = DictionaryStore(tmp_path / "app.sqlite3")
    first = await store.import_library_stream(chunks(archive([record("雨")], title="第一部")))
    second = await store.import_library_stream(chunks(archive([record("猫")], title="第二部")))
    entered, release = threading.Event(), threading.Event()
    original_build = dictionary_store._build  # pyright: ignore[reportPrivateUsage]

    def paused_build(source: Path, target: Path) -> Any:
        result = original_build(source, target)
        entered.set()
        if not release.wait(timeout=10):
            raise AssertionError("publisher was not released")
        return result

    monkeypatch.setattr(dictionary_store, "_build", paused_build)
    async with store.snapshot() as old:
        task = asyncio.create_task(
            store.import_library_stream(chunks(archive([record("鳥")], title="第三部")))
        )
        try:
            assert await asyncio.to_thread(entered.wait, 10)
            selected = await asyncio.wait_for(store.select(second.dictionary_id), timeout=1)
            assert selected.active_dictionary_id == second.dictionary_id
            assert (await old.status()).dictionary_id == first.dictionary_id
            assert [entry.term for entry in await old.find_terms(["雨"])] == ["雨"]
        finally:
            release.set()
        installed = await task
    assert installed.library.active_dictionary_id == second.dictionary_id
    assert len(installed.library.dictionaries) == 3
    assert (await store.status()).dictionary_id == second.dictionary_id


@pytest.mark.asyncio
async def test_concurrent_first_imports_preserve_all_and_mark_duplicate(tmp_path: Path) -> None:
    path = tmp_path / "app.sqlite3"
    stores = [DictionaryStore(path) for _ in range(3)]
    first = archive([record("雨")], title="第一部")
    second = archive([record("猫")], title="第二部")
    results = await asyncio.gather(
        stores[0].import_library_stream(chunks(first)),
        stores[1].import_library_stream(chunks(first)),
        stores[2].import_library_stream(chunks(second)),
    )
    assert sorted(result.already_installed for result in results[:2]) == [False, True]
    library = await stores[0].library()
    assert len(library.dictionaries) == 2
    assert library.active_dictionary_id in {result.dictionary_id for result in results}
    assert len(list(stores[0].library_path.glob("*.sqlite3"))) == 3  # catalog + two indexes
    assert not list(stores[0].library_path.glob(".dictionary-*"))


@pytest.mark.asyncio
async def test_failed_selection_on_empty_library_and_failed_import_are_readable(
    tmp_path: Path,
) -> None:
    store = DictionaryStore(tmp_path / "app.sqlite3")
    with pytest.raises(HTTPException):
        await store.select("unknown")
    assert not (await store.library()).dictionaries
    with pytest.raises(HTTPException):
        await store.import_library_stream(chunks(b"invalid zip"))
    assert not (await store.status()).ready
    result = await store.import_library_stream(chunks(archive([record("雨")])))
    assert result.library.active_dictionary_id == result.dictionary_id


@pytest.mark.asyncio
async def test_cancelled_import_keeps_worker_alive_and_publishes_complete_index(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = DictionaryStore(tmp_path / "app.sqlite3")
    entered, release = threading.Event(), threading.Event()
    original_build = dictionary_store._build  # pyright: ignore[reportPrivateUsage]

    def paused_build(source: Path, target: Path) -> Any:
        result = original_build(source, target)
        entered.set()
        if not release.wait(timeout=10):
            raise AssertionError("publisher was not released")
        return result

    monkeypatch.setattr(dictionary_store, "_build", paused_build)
    task = asyncio.create_task(store.import_library_stream(chunks(archive([record("雨")]))))
    try:
        assert await asyncio.to_thread(entered.wait, 10)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        assert not (await store.status()).ready
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert [item.term for item in await store.find_terms(["雨"])] == ["雨"]
    assert not await asyncio.to_thread(lambda: list(tmp_path.glob(".dictionary-*")))
    assert not await asyncio.to_thread(lambda: list(store.library_path.glob(".dictionary-*")))


@pytest.mark.asyncio
@pytest.mark.parametrize("damage", ["missing", "corrupt", "wrong_identity"])
async def test_same_zip_repairs_damaged_index_without_losing_other_dictionary(
    tmp_path: Path, damage: str
) -> None:
    import sqlite3

    store = DictionaryStore(tmp_path / "app.sqlite3")
    first_raw = archive([record("雨")], title="第一部")
    first = await store.import_library_stream(chunks(first_raw))
    second = await store.import_library_stream(chunks(archive([record("猫")], title="第二部")))
    await store.select(second.dictionary_id)
    broken_path = store.library_path / f"{first.dictionary_id}.sqlite3"
    if damage == "missing":
        broken_path.unlink()
    elif damage == "corrupt":
        broken_path.write_bytes(b"damaged index")
    else:
        with sqlite3.connect(broken_path) as connection:
            connection.execute("UPDATE metadata SET dictionary_id = 'wrong-index'")
    with pytest.raises(HTTPException) as rejected:
        await store.select(first.dictionary_id)
    assert rejected.value.status_code == 422
    assert (await store.library()).active_dictionary_id == second.dictionary_id
    repaired = await store.import_library_stream(chunks(first_raw))
    assert repaired.already_installed
    assert repaired.library.active_dictionary_id == second.dictionary_id
    assert len(repaired.library.dictionaries) == 2
    await store.select(first.dictionary_id)
    assert [entry.term for entry in await store.find_terms(["雨"])] == ["雨"]


@pytest.mark.asyncio
async def test_damaged_legacy_catalog_entry_can_be_repaired_without_overwriting_old_file(
    tmp_path: Path,
) -> None:
    store = DictionaryStore(tmp_path / "app.sqlite3")
    raw = archive([record("雨")])
    first = await asyncio.to_thread(seed_legacy, store, raw)
    await store.import_library_stream(chunks(archive([record("猫")], title="第二部")))
    store.path.write_bytes(b"damaged old index")
    assert not (await store.status()).ready
    repaired = await store.import_library_stream(chunks(raw))
    assert repaired.already_installed
    assert (await store.status()).dictionary_id == first.dictionary_id
    assert [entry.term for entry in await store.find_terms(["雨"])] == ["雨"]
    assert store.path.read_bytes() == b"damaged old index"


@pytest.mark.asyncio
async def test_expected_dictionary_id_rejects_stale_lookup_and_no_dictionary(
    tmp_path: Path,
) -> None:
    async with chat_client(tmp_path / "app.db") as (client, _):
        empty = await client.post(
            "/api/dictionary/lookup", json={"text": "雨", "expected_dictionary_id": "missing"}
        )
        assert empty.status_code == 409
        first = await client.post("/api/dictionary/library/import", content=archive([record("雨")]))
        first_id = first.json()["dictionary_id"]
        second = await client.post(
            "/api/dictionary/library/import", content=archive([record("雨")], title="第二部")
        )
        second_id = second.json()["dictionary_id"]
        await client.put("/api/dictionary/library/selection", json={"dictionary_id": second_id})
        stale = await client.post(
            "/api/dictionary/lookup", json={"text": "雨", "expected_dictionary_id": first_id}
        )
        assert stale.status_code == 409
        current = await client.post(
            "/api/dictionary/lookup", json={"text": "雨", "expected_dictionary_id": second_id}
        )
        assert current.status_code == 200, current.text
        assert {item["dictionary_id"] for item in current.json()["matches"]} == {second_id}


@pytest.mark.asyncio
async def test_expected_id_binds_open_snapshot_even_when_selection_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = DictionaryStore(tmp_path / "app.sqlite3")
    first = await store.import_library_stream(chunks(archive([record("雨")], title="第一部")))
    second = await store.import_library_stream(chunks(archive([record("猫")], title="第二部")))
    original_snapshot = store.snapshot

    @asynccontextmanager
    async def switched_snapshot() -> AsyncGenerator[DictionarySnapshot]:
        async with original_snapshot() as opened:
            await store.select(second.dictionary_id)
            yield opened

    monkeypatch.setattr(store, "snapshot", switched_snapshot)
    result = await lookup(
        store, DictionaryLookupRequest(text="雨", expected_dictionary_id=first.dictionary_id)
    )
    assert {item.dictionary_id for item in result.matches} == {first.dictionary_id}
    assert (await store.library()).active_dictionary_id == second.dictionary_id
