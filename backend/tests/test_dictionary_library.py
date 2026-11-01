"""Library installation, explicit activation and retained single-index compatibility."""

import asyncio
import os
import threading
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, closing
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
        with closing(sqlite3.connect(broken_path)) as connection, connection:
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


@pytest.mark.asyncio
async def test_delete_api_requires_explicit_replacement_and_clears_last_dictionary(
    tmp_path: Path,
) -> None:
    async with chat_client(tmp_path / "app.db") as (client, _):
        first = await client.post(
            "/api/dictionary/library/import", content=archive([record("雨")], title="第一部")
        )
        first_id = first.json()["dictionary_id"]
        second = await client.post(
            "/api/dictionary/library/import", content=archive([record("猫")], title="第二部")
        )
        second_id = second.json()["dictionary_id"]
        library = second.json()["library"]
        for replacement in [None, "missing", first_id]:
            params = {"replacement_dictionary_id": replacement} if replacement else {}
            rejected = await client.delete(f"/api/dictionary/library/{first_id}", params=params)
            assert rejected.status_code == 422, rejected.text
            assert (await client.get("/api/dictionary/library")).json() == library
        deleted = await client.delete(
            f"/api/dictionary/library/{first_id}",
            params={"replacement_dictionary_id": second_id},
        )
        assert deleted.status_code == 200, deleted.text
        assert deleted.json()["active_dictionary_id"] == second_id
        assert [item["dictionary_id"] for item in deleted.json()["dictionaries"]] == [second_id]
        stale = await client.post(
            "/api/dictionary/lookup", json={"text": "雨", "expected_dictionary_id": first_id}
        )
        assert stale.status_code == 409
        assert (await client.post("/api/dictionary/lookup", json={"text": "猫"})).json()["matches"]
        last = await client.delete(f"/api/dictionary/library/{second_id}")
        assert last.json() == {"dictionaries": [], "active_dictionary_id": None}
        assert (await client.get("/api/dictionary")).json()["ready"] is False
        assert (await client.post("/api/dictionary/lookup", json={"text": "猫"})).json() == {
            "matches": []
        }
        assert (await client.delete(f"/api/dictionary/library/{second_id}")).status_code == 404


@pytest.mark.asyncio
async def test_delete_inactive_removes_index_and_preserves_learning_file(tmp_path: Path) -> None:
    learning = tmp_path / "app.db"
    learning.write_bytes(b"independent learning database")
    store = DictionaryStore(tmp_path / "app.db.dictionary.sqlite3")
    first = await store.import_library_stream(chunks(archive([record("雨")], title="第一部")))
    second = await store.import_library_stream(chunks(archive([record("猫")], title="第二部")))
    with pytest.raises(HTTPException) as rejected:
        await store.delete(second.dictionary_id, first.dictionary_id)
    assert rejected.value.status_code == 422
    result = await store.delete(second.dictionary_id)
    assert result.active_dictionary_id == first.dictionary_id
    assert [item.dictionary_id for item in result.dictionaries] == [first.dictionary_id]
    assert not (store.library_path / (second.dictionary_id + ".sqlite3")).exists()
    assert not list(store.library_path.glob("*.deleting-*"))
    assert learning.read_bytes() == b"independent learning database"


@pytest.mark.asyncio
@pytest.mark.parametrize("catalog_exists", [False, True])
async def test_delete_legacy_does_not_revive_after_restart_and_allows_reimport(
    tmp_path: Path, catalog_exists: bool
) -> None:
    store = DictionaryStore(tmp_path / "app.sqlite3")
    raw = archive([record("雨")])
    original = await asyncio.to_thread(seed_legacy, store, raw)
    if catalog_exists:
        await store.select(original.dictionary_id or "")
    async with store.snapshot() as retained:
        deleted = await store.delete(original.dictionary_id or "")
        assert deleted.active_dictionary_id is None
        if os.name != "nt":
            assert not store.path.exists()
        assert [entry.term for entry in await retained.find_terms(["雨"])] == ["雨"]
        assert (await retained.load_definitions(await retained.find_terms(["雨"])))[0].definitions
    restarted = DictionaryStore(store.path)
    assert not store.path.exists()
    assert not (await restarted.library()).dictionaries
    assert not (await restarted.status()).ready
    imported = await restarted.import_library_stream(chunks(raw))
    assert imported.already_installed is False
    assert imported.library.active_dictionary_id == original.dictionary_id
    assert [entry.term for entry in await restarted.find_terms(["雨"])] == ["雨"]


@pytest.mark.asyncio
@pytest.mark.parametrize("reimport,cleanup_failure", [(False, False), (True, False), (False, True)])
async def test_busy_index_deletion_retains_reader_and_preserves_reimport(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, reimport: bool, cleanup_failure: bool
) -> None:
    import aiosqlite

    store = DictionaryStore(tmp_path / "app.sqlite3")
    raw = archive([record("雨")])
    first = await store.import_library_stream(chunks(raw))
    path = store.library_path / (first.dictionary_id + ".sqlite3")
    replace, unlink = dictionary_store.os.replace, Path.unlink
    reader_open = True
    commit = aiosqlite.Connection.commit
    deletion_committed = False

    async def fail_cleanup_commit(connection: aiosqlite.Connection) -> None:
        nonlocal deletion_committed
        async with connection.execute("SELECT count(*) FROM dictionaries") as cursor:
            row = await cursor.fetchone()
        if row == (0,):
            if deletion_committed:
                raise aiosqlite.OperationalError("injected cleanup failure")
            deletion_committed = True
        await commit(connection)

    def busy_replace(source: Path, target: Path) -> None:
        if source == path and reader_open:
            raise PermissionError("open SQLite file cannot be renamed on Windows")
        replace(source, target)

    def busy_unlink(target: Path, missing_ok: bool = False) -> None:
        if target == path and reader_open:
            raise PermissionError("open SQLite file cannot be removed on Windows")
        unlink(target, missing_ok=missing_ok)

    monkeypatch.setattr(dictionary_store.os, "replace", busy_replace)
    monkeypatch.setattr(Path, "unlink", busy_unlink)
    if cleanup_failure:
        monkeypatch.setattr(aiosqlite.Connection, "commit", fail_cleanup_commit)
    async with store.snapshot() as retained:
        assert not (await store.delete(first.dictionary_id)).dictionaries
        assert path.exists()
        assert not (await DictionaryStore(store.path).status()).ready
        assert [entry.term for entry in await retained.find_terms(["雨"])] == ["雨"]
        if reimport:
            # Another installer can reuse the immutable file while the old reader
            # finishes. Its newly committed catalog reference must protect it.
            await DictionaryStore(store.path).import_library_stream(chunks(raw))
        reader_open = False
    assert path.exists() == reimport
    assert (await store.status()).ready == reimport


@pytest.mark.asyncio
async def test_busy_index_failed_commit_preserves_catalog_and_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import aiosqlite

    store = DictionaryStore(tmp_path / "app.sqlite3")
    first = await store.import_library_stream(chunks(archive([record("雨")])))
    path = store.library_path / (first.dictionary_id + ".sqlite3")
    replace = dictionary_store.os.replace
    commit = aiosqlite.Connection.commit

    def busy_replace(source: Path, target: Path) -> None:
        if source == path:
            raise PermissionError("open SQLite file")
        replace(source, target)

    async def failed_commit(connection: aiosqlite.Connection) -> None:
        async with connection.execute("SELECT count(*) FROM dictionaries") as cursor:
            row = await cursor.fetchone()
        if row == (0,):
            raise OSError("injected commit failure")
        await commit(connection)

    monkeypatch.setattr(dictionary_store.os, "replace", busy_replace)
    monkeypatch.setattr(aiosqlite.Connection, "commit", failed_commit)
    with pytest.raises(OSError, match="commit failure"):
        await store.delete(first.dictionary_id)
    assert await store.library() == first.library
    assert path.exists()
    assert [entry.term for entry in await store.find_terms(["雨"])] == ["雨"]


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.parametrize("mutation", ["select", "import"])
async def test_restart_reclaims_busy_deletion_orphan_on_next_mutation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, legacy: bool, mutation: str
) -> None:
    store = DictionaryStore(tmp_path / "app.sqlite3")
    first_raw = archive([record("雨")], title="第一部")
    if legacy:
        first_id = (await asyncio.to_thread(seed_legacy, store, first_raw)).dictionary_id or ""
        path = store.path
    else:
        first_id = (await store.import_library_stream(chunks(first_raw))).dictionary_id
        path = store.library_path / (first_id + ".sqlite3")
    second = await store.import_library_stream(chunks(archive([record("猫")], title="第二部")))
    replace, unlink = dictionary_store.os.replace, Path.unlink

    def busy_replace(source: Path, target: Path) -> None:
        if source == path:
            raise PermissionError("open SQLite file")
        replace(source, target)

    def busy_unlink(target: Path, missing_ok: bool = False) -> None:
        if target == path:
            raise PermissionError("open SQLite file")
        unlink(target, missing_ok=missing_ok)

    with monkeypatch.context() as busy:
        busy.setattr(dictionary_store.os, "replace", busy_replace)
        busy.setattr(Path, "unlink", busy_unlink)
        await store.delete(first_id, second.dictionary_id)
    assert path.exists()
    restarted = DictionaryStore(store.path)
    assert (await restarted.status()).dictionary_id == second.dictionary_id
    if mutation == "select":
        await restarted.select(second.dictionary_id)
    else:
        reimported = await restarted.import_library_stream(chunks(first_raw))
        assert not reimported.already_installed
        assert path.exists() == (not legacy)
        await restarted.select(first_id)
        assert [entry.term for entry in await restarted.find_terms(["雨"])] == ["雨"]
        # Reimport publishes a directory index even when the orphan was legacy.
        assert (restarted.library_path / (first_id + ".sqlite3")).exists()
    assert path.exists() == (mutation == "import" and not legacy)


@pytest.mark.asyncio
async def test_library_mutation_preserves_unrecognized_damaged_legacy_file(tmp_path: Path) -> None:
    store = DictionaryStore(tmp_path / "app.sqlite3")
    original = b"unrecognized legacy dictionary"
    store.path.write_bytes(original)
    installed = await store.import_library_stream(chunks(archive([record("雨")])))
    store = DictionaryStore(store.path)
    await store.select(installed.dictionary_id)
    await store.delete(installed.dictionary_id)
    assert store.path.read_bytes() == original


@pytest.mark.asyncio
async def test_delete_rejects_damaged_replacement_without_changing_selection(
    tmp_path: Path,
) -> None:
    store = DictionaryStore(tmp_path / "app.sqlite3")
    first = await store.import_library_stream(chunks(archive([record("雨")], title="第一部")))
    second = await store.import_library_stream(chunks(archive([record("猫")], title="第二部")))
    (store.library_path / (second.dictionary_id + ".sqlite3")).write_bytes(b"damaged")
    before = await store.library()
    with pytest.raises(HTTPException) as rejected:
        await store.delete(first.dictionary_id, second.dictionary_id)
    assert rejected.value.status_code == 422
    assert await store.library() == before
    assert [entry.term for entry in await store.find_terms(["雨"])] == ["雨"]


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["move", "commit"])
async def test_failed_delete_restores_catalog_and_index(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    import aiosqlite

    store = DictionaryStore(tmp_path / "app.sqlite3")
    first = await store.import_library_stream(chunks(archive([record("雨")])))
    path = store.library_path / (first.dictionary_id + ".sqlite3")
    original = path.read_bytes()
    if failure == "move":
        original_replace = dictionary_store.os.replace

        def fail_move(source: Path, target: Path) -> None:
            if ".deleting-" in target.name:
                raise OSError("injected staging failure")
            original_replace(source, target)

        monkeypatch.setattr(dictionary_store.os, "replace", fail_move)
    else:
        original_commit = aiosqlite.Connection.commit

        async def fail_deleted_commit(connection: aiosqlite.Connection) -> None:
            async with connection.execute("SELECT count(*) FROM dictionaries") as cursor:
                row = await cursor.fetchone()
            if row and row[0] == 0:
                raise OSError("injected commit failure")
            await original_commit(connection)

        original_rollback = aiosqlite.Connection.rollback

        async def verify_restored_before_unlock(connection: aiosqlite.Connection) -> None:
            assert path.read_bytes() == original
            await original_rollback(connection)

        monkeypatch.setattr(aiosqlite.Connection, "commit", fail_deleted_commit)
        monkeypatch.setattr(aiosqlite.Connection, "rollback", verify_restored_before_unlock)
    with pytest.raises(OSError):
        await store.delete(first.dictionary_id)
    assert await store.library() == first.library
    assert path.read_bytes() == original
    assert [entry.term for entry in await store.find_terms(["雨"])] == ["雨"]
    assert not list(store.library_path.glob("*.deleting-*"))


@pytest.mark.asyncio
async def test_interrupted_staging_remains_readable_and_can_be_deleted(tmp_path: Path) -> None:
    store = DictionaryStore(tmp_path / "app.sqlite3")
    first = await store.import_library_stream(chunks(archive([record("雨")])))
    path = store.library_path / (first.dictionary_id + ".sqlite3")
    retained = path.with_name(path.name + ".deleting-interrupted")
    path.rename(retained)  # Simulate a process exit before catalog commit.
    restarted = DictionaryStore(store.path)
    assert (await restarted.status()).dictionary_id == first.dictionary_id
    assert [entry.term for entry in await restarted.find_terms(["雨"])] == ["雨"]
    assert not (await restarted.delete(first.dictionary_id)).dictionaries
    assert not retained.exists()


@pytest.mark.asyncio
async def test_import_build_does_not_block_delete_and_late_import_becomes_first(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = DictionaryStore(tmp_path / "app.sqlite3")
    first = await store.import_library_stream(chunks(archive([record("雨")], title="第一部")))
    entered, release = threading.Event(), threading.Event()
    original_build = dictionary_store._build  # pyright: ignore[reportPrivateUsage]

    def paused_build(source: Path, target: Path) -> Any:
        result = original_build(source, target)
        entered.set()
        if not release.wait(timeout=10):
            raise AssertionError("builder was not released")
        return result

    monkeypatch.setattr(dictionary_store, "_build", paused_build)
    other = DictionaryStore(store.path)
    task = asyncio.create_task(
        other.import_library_stream(chunks(archive([record("猫")], title="第二部")))
    )
    try:
        assert await asyncio.to_thread(entered.wait, 10)
        async with store.snapshot() as retained:
            deleted = await asyncio.wait_for(store.delete(first.dictionary_id), timeout=1)
            assert not deleted.dictionaries
            assert [entry.term for entry in await retained.find_terms(["雨"])] == ["雨"]
    finally:
        release.set()
    imported = await task
    assert imported.library.active_dictionary_id == imported.dictionary_id
    assert [entry.term for entry in await store.find_terms(["猫"])] == ["猫"]
    assert not list(store.library_path.glob("*.deleting-*"))


@pytest.mark.asyncio
async def test_concurrent_deletions_validate_replacement_in_same_transaction(
    tmp_path: Path,
) -> None:
    store = DictionaryStore(tmp_path / "app.sqlite3")
    first = await store.import_library_stream(chunks(archive([record("雨")], title="第一部")))
    second = await store.import_library_stream(chunks(archive([record("猫")], title="第二部")))
    results = await asyncio.gather(
        store.delete(first.dictionary_id, second.dictionary_id),
        DictionaryStore(store.path).delete(second.dictionary_id),
        return_exceptions=True,
    )
    assert all(
        not isinstance(result, Exception) or isinstance(result, HTTPException) for result in results
    )
    library = await store.library()
    ids = {item.dictionary_id for item in library.dictionaries}
    assert library.active_dictionary_id in ids if ids else library.active_dictionary_id is None
    if ids:
        assert ids == {first.dictionary_id}
        assert (await store.status()).dictionary_id == first.dictionary_id
    else:
        assert not (await store.status()).ready


@pytest.mark.asyncio
async def test_failed_postcommit_cleanup_does_not_revive_and_is_retried_after_reimport(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = DictionaryStore(tmp_path / "app.sqlite3")
    raw = archive([record("雨")])
    first = await store.import_library_stream(chunks(raw))
    original_unlink = Path.unlink

    def fail_cleanup(path: Path, missing_ok: bool = False) -> None:
        if ".deleting-" in path.name:
            raise OSError("injected postcommit cleanup failure")
        original_unlink(path, missing_ok=missing_ok)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "unlink", fail_cleanup)
        assert not (await store.delete(first.dictionary_id)).dictionaries
    assert list(store.library_path.glob("*.deleting-*"))
    restarted = DictionaryStore(store.path)
    assert not (await restarted.status()).ready
    imported = await restarted.import_library_stream(chunks(raw))
    assert not imported.already_installed
    assert [entry.term for entry in await restarted.find_terms(["雨"])] == ["雨"]
    await restarted.delete(first.dictionary_id)
    assert not list(store.library_path.glob("*.deleting-*"))


@pytest.mark.asyncio
async def test_old_cleanup_cannot_remove_concurrent_delete_rollback_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import aiosqlite

    store = DictionaryStore(tmp_path / "app.sqlite3")
    raw = archive([record("雨")])
    first = await store.import_library_stream(chunks(raw))
    entered, release, cleaned = threading.Event(), threading.Event(), threading.Event()
    original_unlink = Path.unlink
    original_commit = aiosqlite.Connection.commit
    blocked_path: list[Path] = []

    def paused_cleanup(path: Path, missing_ok: bool = False) -> None:
        if ".deleting-" in path.name and not blocked_path:
            blocked_path.append(path)
            entered.set()
            if not release.wait(timeout=10):
                raise AssertionError("cleanup was not released")
            original_unlink(path, missing_ok=missing_ok)
            cleaned.set()
        else:
            original_unlink(path, missing_ok=missing_ok)

    async def fail_second_delete_commit(connection: aiosqlite.Connection) -> None:
        async with connection.execute("SELECT count(*) FROM dictionaries") as cursor:
            row = await cursor.fetchone()
        if row and row[0] == 0:
            release.set()
            assert await asyncio.to_thread(cleaned.wait, 10)
            raise OSError("injected second deletion commit failure")
        await original_commit(connection)

    monkeypatch.setattr(Path, "unlink", paused_cleanup)
    first_delete = asyncio.create_task(store.delete(first.dictionary_id))
    try:
        assert await asyncio.to_thread(entered.wait, 10)
        other = DictionaryStore(store.path)
        imported = await other.import_library_stream(chunks(raw))
        monkeypatch.setattr(aiosqlite.Connection, "commit", fail_second_delete_commit)
        with pytest.raises(OSError):
            await other.delete(first.dictionary_id)
        assert await other.library() == imported.library
        assert [entry.term for entry in await other.find_terms(["雨"])] == ["雨"]
    finally:
        release.set()
        await first_delete
    assert not list(store.library_path.glob("*.deleting-*"))


@pytest.mark.asyncio
async def test_opening_snapshot_and_delete_are_coordinated_without_holding_reader_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = DictionaryStore(tmp_path / "app.sqlite3")
    first = await store.import_library_stream(chunks(archive([record("雨")])))
    index = store.library_path / (first.dictionary_id + ".sqlite3")
    entered, release, opened, finish = (asyncio.Event() for _ in range(4))
    original_snapshot = store._file_snapshot  # pyright: ignore[reportPrivateUsage]

    @asynccontextmanager
    async def paused_open(path: Path) -> AsyncGenerator[DictionarySnapshot]:
        if path == index:
            entered.set()
            await release.wait()
        async with original_snapshot(path) as snapshot:
            yield snapshot

    async def read_snapshot() -> list[str]:
        async with store.snapshot() as snapshot:
            opened.set()
            await finish.wait()
            return [entry.term for entry in await snapshot.find_terms(["雨"])]

    monkeypatch.setattr(store, "_file_snapshot", paused_open)
    reader = asyncio.create_task(read_snapshot())
    delete: asyncio.Task[Any] | None = None
    try:
        await asyncio.wait_for(entered.wait(), timeout=1)
        delete = asyncio.create_task(DictionaryStore(store.path).delete(first.dictionary_id))
        await asyncio.sleep(0.05)
        assert not delete.done()
        release.set()
        await asyncio.wait_for(opened.wait(), timeout=1)
        assert not (await asyncio.wait_for(delete, timeout=1)).dictionaries
        finish.set()
        assert await reader == ["雨"]
    finally:
        release.set()
        finish.set()
        await reader
        if delete is not None:
            await delete
