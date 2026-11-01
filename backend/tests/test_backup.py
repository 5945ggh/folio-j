"""Real offline backup CLI preserves learning identities and rejects unsafe inputs."""

import fcntl
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from alembic.config import Config
from support_api import accept, chat_client, seed_chat
from test_dictionary_store import archive, chunks, record, seed_legacy
from test_epub_compiler import publication

from alembic import command
from app.services.dictionary_store import DictionaryStore
from app.services.settings import read_credential

ROOT = Path(__file__).resolve().parents[2]
Cli = Callable[..., subprocess.CompletedProcess[str]]


@pytest.fixture
def backup_cli(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Cli:
    """Carry the suite's network ban into subprocesses, which do not inherit mocks."""
    guard = tmp_path / "offline-python"
    guard.mkdir()
    marker = tmp_path / "network-attempt"
    (guard / "sitecustomize.py").write_text(
        "import socket\n"
        "from pathlib import Path\n"
        "def deny(*args, **kwargs):\n"
        f"    Path({str(marker)!r}).write_text('forbidden')\n"
        "    raise RuntimeError('Network access is forbidden in backup tests')\n"
        "socket.socket.connect = deny\n"
        "socket.socket.connect_ex = deny\n"
        "socket.create_connection = deny\n"
        "socket.getaddrinfo = deny\n"
        "import os\n"
        "if installation := os.environ.get('FOLIO_TEST_INSTALLATION'):\n"
        "    import app.config\n"
        "    app.config.REPO_ROOT = Path(installation)\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("PYTHONPATH", os.pathsep.join((str(guard), str(ROOT / "backend/src"))))

    def run(*arguments: str | Path) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            [sys.executable, "-m", "app.backup", *(str(item) for item in arguments)],
            cwd=ROOT,
            env=os.environ.copy(),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        assert not marker.exists(), "backup/restore attempted real network access"
        return result

    return run


@pytest.fixture
def database(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "original" / "custom-name.sqlite3"
    path.parent.mkdir()
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(path))
    config = Config()
    config.set_main_option("script_location", str(ROOT / "backend/alembic"))
    command.upgrade(config, "head")
    return path


def _rows(path: Path) -> dict[str, list[tuple[Any, ...]]]:
    with sqlite3.connect(path) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        return {
            name: connection.execute(f'SELECT * FROM "{name}" ORDER BY rowid').fetchall()
            for (name,) in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }


def _success(result: subprocess.CompletedProcess[str]) -> None:
    assert result.returncode == 0, result.stdout + result.stderr


def _failure(result: subprocess.CompletedProcess[str]) -> None:
    assert result.returncode != 0, result.stdout + result.stderr
    assert result.stderr.strip()
    assert "Traceback" not in result.stderr


@pytest.mark.asyncio
async def test_cli_roundtrip_preserves_epub_bookmark_dictionary_credentials_and_pending_job(
    tmp_path: Path, database: Path, backup_cli: Cli
) -> None:
    # Reuse the synthetic dictionary factory and the actual managed EPUB compiler.
    legacy = DictionaryStore(database.with_name(database.name + ".dictionary.sqlite3"))
    seed_legacy(legacy, archive([record("雨")], title="既有合成词典"))
    async with chat_client(database) as (client, _):
        seed = await seed_chat(client)
        uploaded = await client.post(
            f"/api/sources/{seed['source']['id']}/materials",
            content=publication(tmp_path),
            headers={"content-type": "application/epub+zip"},
        )
        assert uploaded.status_code == 200, uploaded.text
        material = uploaded.json()["material"]
        url = f"/api/materials/{material['id']}"
        chapter = (await client.get(url + "/chapters/" + material["chapters"][0]["id"])).json()
        part = chapter["parts"][0]
        bookmark = await client.post(
            url + "/bookmarks",
            json={
                "request_id": str(uuid4()),
                "position": {
                    "version_id": material["version_id"],
                    "chapter_id": chapter["id"],
                    "part_index": 0,
                    "resource_id": part["resource_id"],
                    "kind": "text",
                    "offset": part["start"],
                },
            },
        )
        assert bookmark.status_code == 200, bookmark.text
        installed = await client.post(
            "/api/dictionary/library/import", content=archive([record("猫")], title="新增合成词典")
        )
        assert installed.status_code == 200, installed.text
        selected = await client.put(
            "/api/dictionary/library/selection",
            json={"dictionary_id": installed.json()["dictionary_id"]},
        )
        assert selected.status_code == 200, selected.text
        job = await accept(client, seed)
    before = _rows(database)
    assert before["runs"] == []
    assert before["material_bookmarks"]
    with sqlite3.connect(database) as connection:
        credential_ref = connection.execute("SELECT credential_ref FROM providers").fetchone()
    assert credential_ref is not None
    assert read_credential(database, credential_ref[0]) == "fictional-chat-secret"

    backup = tmp_path / "backup"
    _success(backup_cli("create", backup))
    manifest = json.loads((backup / "manifest.json").read_text())
    assert manifest["format_version"] == 1
    assert manifest["components"] == {
        "credentials": True,
        "dictionary_index": True,
        "dictionary_library": True,
    }
    assert "app.db" in manifest["files"]
    for name, expected in manifest["files"].items():
        raw = (backup / name).read_bytes()
        assert len(raw) == expected["size"]
        assert hashlib.sha256(raw).hexdigest() == expected["sha256"]
    assert "fictional-chat-secret" not in (backup / "manifest.json").read_text()
    assert _rows(database) == before

    restored_directory = tmp_path / "restored"
    result = backup_cli("restore", backup, restored_directory)
    _success(result)
    restored = restored_directory / "app.db"
    assert str(restored) in result.stdout
    assert _rows(restored) == before  # Includes queued job: CLI never starts recovery or models.
    assert read_credential(restored, credential_ref[0]) == "fictional-chat-secret"
    async with chat_client(restored) as (client, _):
        assert (await client.get(url)).json() == material
        assert (await client.get(url + "/chapters/" + chapter["id"])).json() == chapter
        item = await client.get(url + "/bookmarks/" + bookmark.json()["id"])
        assert item.json() == bookmark.json()
        assert (await client.get("/api/dictionary/library")).json() == selected.json()
        lookup = await client.post("/api/dictionary/lookup", json={"text": "猫"})
        assert lookup.json()["matches"]
        assert (await client.get(f"/api/jobs/{job['id']}")).status_code == 200
    assert _rows(restored)["runs"] == []


def test_cli_database_only_backup_has_optional_components_absent(
    tmp_path: Path, database: Path, backup_cli: Cli
) -> None:
    backup = tmp_path / "backup"
    _success(backup_cli("create", backup))
    manifest = json.loads((backup / "manifest.json").read_text())
    assert manifest["components"] == dict.fromkeys(
        ("credentials", "dictionary_index", "dictionary_library"), False
    )
    restored = tmp_path / "restored"
    _success(backup_cli("restore", backup, restored))
    assert _rows(restored / "app.db") == _rows(database)


@pytest.mark.parametrize("damage", ["manifest_missing", "database_missing", "corrupt", "version"])
def test_cli_rejects_incomplete_corrupt_or_unsupported_backup_without_publishing_target(
    tmp_path: Path, database: Path, backup_cli: Cli, damage: str
) -> None:
    backup = tmp_path / "backup"
    _success(backup_cli("create", backup))
    manifest_path = backup / "manifest.json"
    if damage == "manifest_missing":
        manifest_path.unlink()
    elif damage == "database_missing":
        (backup / "app.db").unlink()
    elif damage == "corrupt":
        (backup / "app.db").write_bytes(b"damaged database")
    else:
        manifest = json.loads(manifest_path.read_text())
        manifest["format_version"] = 999
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    target = tmp_path / "restored"
    _failure(backup_cli("restore", backup, target))
    assert not target.exists()
    assert _rows(database)["runs"] == []


@pytest.mark.parametrize("operation", ["create", "restore"])
@pytest.mark.parametrize("populated", [False, True])
def test_cli_refuses_existing_target_including_empty_directory(
    tmp_path: Path, database: Path, backup_cli: Cli, operation: str, populated: bool
) -> None:
    backup = tmp_path / "backup"
    _success(backup_cli("create", backup))
    target = tmp_path / "existing"
    target.mkdir()
    if populated:
        (target / "app.db").write_bytes(b"never overwrite")
    before = {entry.name: entry.read_bytes() for entry in target.iterdir()}
    args = ("create", target) if operation == "create" else ("restore", backup, target)
    _failure(backup_cli(*args))
    assert {entry.name: entry.read_bytes() for entry in target.iterdir()} == before


def test_cli_refuses_backup_while_application_holds_worker_lock(
    tmp_path: Path, database: Path, backup_cli: Cli
) -> None:
    lock = database.with_name(database.name + ".worker.lock")
    target = tmp_path / "backup"
    with lock.open("a+b") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            result = backup_cli("create", target)
            _failure(result)
            assert not target.exists()
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)
    _success(backup_cli("create", target))


def test_cli_missing_source_does_not_silently_create_database(
    tmp_path: Path, backup_cli: Cli, monkeypatch: pytest.MonkeyPatch
) -> None:
    missing = tmp_path / "missing.db"
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(missing))
    target = tmp_path / "backup"
    _failure(backup_cli("create", target))
    assert not missing.exists()
    assert not target.exists()


@pytest.mark.asyncio
async def test_cli_accepts_deleted_material_tombstone(
    tmp_path: Path, database: Path, backup_cli: Cli
) -> None:
    async with chat_client(database) as (client, _):
        source = (await client.post("/api/sources", json={"title": "保留出处"})).json()
        uploaded = await client.post(
            f"/api/sources/{source['id']}/materials",
            content=publication(tmp_path),
            headers={"content-type": "application/epub+zip"},
        )
        assert uploaded.status_code == 200, uploaded.text
        material_id = uploaded.json()["material"]["id"]
        assert (await client.delete(f"/api/materials/{material_id}")).status_code == 204
    before = _rows(database)
    backup = tmp_path / "backup"
    restored = tmp_path / "restored"
    _success(backup_cli("create", backup))
    _success(backup_cli("restore", backup, restored))
    assert _rows(restored / "app.db") == before


def test_cli_captures_committed_wal_data_without_changing_original(
    tmp_path: Path, database: Path, backup_cli: Cli
) -> None:
    with sqlite3.connect(database) as writer:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute(
            "INSERT INTO sources (id,title,description,note,created_at,updated_at) "
            "VALUES ('wal-source','WAL 中的资料','说明','备注','2026-01-01','2026-01-01')"
        )
        writer.commit()
        assert Path(str(database) + "-wal").stat().st_size > 0
        before = _rows(database)
        backup = tmp_path / "backup"
        restored = tmp_path / "restored"
        _success(backup_cli("create", backup))
        _success(backup_cli("restore", backup, restored))
        assert _rows(database) == before
        assert _rows(restored / "app.db") == before


@pytest.mark.parametrize("damage", ["invalid_sqlite", "schema_revision", "path_escape", "symlink"])
def test_cli_validates_content_beyond_checksums_and_rejects_links(
    tmp_path: Path, database: Path, backup_cli: Cli, damage: str
) -> None:
    backup = tmp_path / "backup"
    _success(backup_cli("create", backup))
    manifest_path = backup / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    payload = backup / "app.db"
    if damage == "invalid_sqlite":
        payload.write_bytes(b"matching digest does not make this a database")
    elif damage == "schema_revision":
        with sqlite3.connect(payload) as connection:
            connection.execute("UPDATE alembic_version SET version_num='future_schema'")
    elif damage == "path_escape":
        manifest["files"]["../outside.db"] = manifest["files"]["app.db"]
    else:
        outside = tmp_path / "outside.db"
        outside.write_bytes(payload.read_bytes())
        payload.unlink()
        payload.symlink_to(outside)
    raw = payload.read_bytes()
    manifest["files"]["app.db"] = {"size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    target = tmp_path / "restored"
    _failure(backup_cli("restore", backup, target))
    assert not target.exists()
    assert _rows(database)["runs"] == []


@pytest.mark.asyncio
async def test_cli_rejects_missing_referenced_credential_without_publishing_backup(
    tmp_path: Path, database: Path, backup_cli: Cli
) -> None:
    async with chat_client(database) as (client, _):
        await seed_chat(client)
    secrets = database.with_name(database.name + ".secrets")
    for credential in secrets.iterdir():
        credential.unlink()
    target = tmp_path / "backup"
    _failure(backup_cli("create", target))
    assert not target.exists()
    assert list(secrets.iterdir()) == []


@pytest.mark.asyncio
async def test_cli_preserves_dictionary_catalog_changes_still_in_wal(
    tmp_path: Path, database: Path, backup_cli: Cli
) -> None:
    store = DictionaryStore(database.with_name(database.name + ".dictionary.sqlite3"))
    installed = await store.import_library_stream(chunks(archive([record("猫")])))
    with sqlite3.connect(store.catalog_path) as writer:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("UPDATE dictionaries SET title='WAL 中的词典'")
        writer.commit()
        assert os.stat(str(store.catalog_path) + "-wal").st_size > 0
        before = _rows(store.catalog_path)
        backup, restored = tmp_path / "backup", tmp_path / "restored"
        _success(backup_cli("create", backup))
        _success(backup_cli("restore", backup, restored))
        restored_store = DictionaryStore(restored / "app.db.dictionary.sqlite3")
        assert _rows(restored_store.catalog_path) == before
        library = await restored_store.library()
        assert library.active_dictionary_id == installed.dictionary_id
        assert library.dictionaries[0].title == "WAL 中的词典"


@pytest.mark.parametrize(
    "field",
    ["format_version", "database", "revision", "epub_contract", "epub_storage_version"],
)
def test_cli_requires_explicit_manifest_versions(
    tmp_path: Path, database: Path, backup_cli: Cli, field: str
) -> None:
    backup = tmp_path / "backup"
    _success(backup_cli("create", backup))
    manifest_path = backup / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if field in ("format_version", "database"):
        del manifest[field]
    else:
        del manifest["database"][field]
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    target = tmp_path / "restored"
    _failure(backup_cli("restore", backup, target))
    assert not target.exists()


def test_cli_rejects_undeclared_files_and_keeps_destination_unpublished(
    tmp_path: Path, database: Path, backup_cli: Cli
) -> None:
    backup = tmp_path / "backup"
    _success(backup_cli("create", backup))
    (backup / "undeclared.txt").write_text("do not restore", encoding="utf-8")
    target = tmp_path / "restored"
    _failure(backup_cli("restore", backup, target))
    assert not target.exists()


def test_cli_preserves_declared_empty_credential_subdirectories(
    tmp_path: Path, database: Path, backup_cli: Cli
) -> None:
    empty = database.with_name(database.name + ".secrets") / "empty" / "nested"
    empty.mkdir(parents=True)
    backup, restored = tmp_path / "backup", tmp_path / "restored"
    _success(backup_cli("create", backup))
    _success(backup_cli("restore", backup, restored))
    assert (restored / "app.db.secrets/empty/nested").is_dir()
    assert list((restored / "app.db.secrets/empty/nested").iterdir()) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy", [False, True], ids=["library-index", "legacy-index"])
async def test_cli_preserves_readable_dictionary_after_interrupted_delete_before_catalog_commit(
    tmp_path: Path, database: Path, backup_cli: Cli, legacy: bool
) -> None:
    store = DictionaryStore(database.with_name(database.name + ".dictionary.sqlite3"))
    if legacy:
        status = seed_legacy(store, archive([record("雨")], title="保留的旧词典"))
        # A real second installation bootstraps the catalog while keeping legacy active.
        await store.import_library_stream(chunks(archive([record("猫")], title="另一部词典")))
        identity, source, term = status.dictionary_id, store.path, "雨"
    else:
        installed = await store.import_library_stream(chunks(archive([record("猫")])))
        identity = installed.dictionary_id
        source, term = store.library_path / f"{identity}.sqlite3", "猫"
    expected_library = await store.library()
    assert expected_library.active_dictionary_id == identity
    before_database, before_catalog = _rows(database), _rows(store.catalog_path)
    # A killed deletion leaves the filesystem rename, while SQLite rolls back its catalog txn.
    retained = source.with_name(source.name + ".deleting-interrupted-test")
    source.rename(retained)
    assert (await store.status()).ready
    async with store.snapshot() as snapshot:
        assert [item.term for item in await snapshot.find_terms([term])] == [term]

    backup, restored = tmp_path / "backup", tmp_path / "restored"
    _success(backup_cli("create", backup))
    _success(backup_cli("restore", backup, restored))
    restored_store = DictionaryStore(restored / "app.db.dictionary.sqlite3")
    assert await restored_store.library() == expected_library
    assert (await restored_store.status()).ready
    async with restored_store.snapshot() as snapshot:
        assert [item.term for item in await snapshot.find_terms([term])] == [term]
    assert _rows(restored / "app.db") == before_database
    assert _rows(database) == before_database
    assert _rows(store.catalog_path) == before_catalog
    assert not source.exists() and retained.is_file()


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy", [False, True], ids=["library-index", "legacy-index"])
async def test_cli_does_not_revive_committed_dictionary_deletion_with_retained_cleanup_files(
    tmp_path: Path, database: Path, backup_cli: Cli, monkeypatch: pytest.MonkeyPatch, legacy: bool
) -> None:
    store = DictionaryStore(database.with_name(database.name + ".dictionary.sqlite3"))
    if legacy:
        identity = seed_legacy(store, archive([record("雨")])).dictionary_id
        source = store.path
    else:
        installed = await store.import_library_stream(chunks(archive([record("猫")])))
        identity = installed.dictionary_id
        source = store.library_path / f"{identity}.sqlite3"
    assert identity is not None
    unlink = Path.unlink

    def retain_cleanup_file(path: Path, missing_ok: bool = False) -> None:
        if ".deleting-" in path.name:
            raise OSError("synthetic cleanup failure after catalog commit")
        unlink(path, missing_ok=missing_ok)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "unlink", retain_cleanup_file)
        expected_library = await store.delete(identity)
    assert expected_library.dictionaries == []
    assert expected_library.active_dictionary_id is None
    assert list(source.parent.glob(source.name + ".deleting-*"))
    backup, restored = tmp_path / "backup", tmp_path / "restored"
    _success(backup_cli("create", backup))
    _success(backup_cli("restore", backup, restored))
    restored_store = DictionaryStore(restored / "app.db.dictionary.sqlite3")
    assert await restored_store.library() == expected_library
    assert not (await restored_store.status()).ready


def test_cli_backup_protocol_survives_a_normal_forward_schema_migration(
    tmp_path: Path, database: Path, backup_cli: Cli, monkeypatch: pytest.MonkeyPatch
) -> None:
    baseline = "0004_translation_reader_removal"
    successor = "0005_test_backup_upgrade"
    installation = tmp_path / "new-installation"
    migrations = installation / "backend/alembic"
    shutil.copytree(
        ROOT / "backend/alembic", migrations, ignore=shutil.ignore_patterns("__pycache__")
    )
    (migrations / "versions/0005_test_backup_upgrade.py").write_text(
        "from alembic import op\n"
        "import sqlalchemy as sa\n"
        f"revision = {successor!r}\n"
        f"down_revision = {baseline!r}\n"
        "branch_labels = None\ndepends_on = None\n"
        "def upgrade():\n"
        "    op.add_column('sources', sa.Column('upgrade_note', sa.Text(), "
        "nullable=False, server_default='new-default'))\n"
        "def downgrade():\n"
        "    op.drop_column('sources', 'upgrade_note')\n",
        encoding="utf-8",
    )
    (installation / "RELEASE.json").write_text(
        json.dumps({"version": "0.2.0-test", "commit": None}), encoding="utf-8"
    )
    with sqlite3.connect(database) as connection:
        connection.execute(
            "INSERT INTO sources (id,title,description,note,created_at,updated_at) "
            "VALUES ('preserved','前向升级𠮷','说明','备注','2026-01-01','2026-01-01')"
        )
    before = _rows(database)
    old_backup = tmp_path / "old-backup"
    _success(backup_cli("create", old_backup))
    old_manifest = json.loads((old_backup / "manifest.json").read_text())
    assert old_manifest["format_version"] == 1
    assert old_manifest["database"]["revision"] == baseline

    # The subprocess imports the same backup code with the simulated installation's chain.
    monkeypatch.setenv("FOLIO_TEST_INSTALLATION", str(installation))
    old_restored = tmp_path / "old-restored-by-new"
    _success(backup_cli("restore", old_backup, old_restored))
    restored_database = old_restored / "app.db"
    assert _rows(restored_database) == before  # Restore itself never silently migrates.
    monkeypatch.setenv("FOLIO_J_DATABASE_PATH", str(restored_database))
    config = Config()
    config.set_main_option("script_location", str(migrations))
    command.upgrade(config, "head")  # The normal application's separate upgrade path.
    upgraded = _rows(restored_database)
    assert upgraded.pop("alembic_version") == [(successor,)]
    assert upgraded.pop("sources") == [(*before["sources"][0], "new-default")]
    assert upgraded == {
        table: rows for table, rows in before.items() if table not in ("sources", "alembic_version")
    }

    new_backup = tmp_path / "new-backup"
    _success(backup_cli("create", new_backup))
    manifest = json.loads((new_backup / "manifest.json").read_text())
    assert manifest["format_version"] == old_manifest["format_version"] == 1
    assert manifest["database"]["revision"] == successor
    assert manifest["application"]["version"] == "0.2.0-test"
    new_restored = tmp_path / "new-restored"
    _success(backup_cli("restore", new_backup, new_restored))
    assert _rows(new_restored / "app.db") == _rows(restored_database)

    # Both revisions are supported by the new chain, but their pairing must still match.
    for package, wrong_revision in ((old_backup, successor), (new_backup, baseline)):
        mismatch = tmp_path / f"mismatch-{wrong_revision}"
        shutil.copytree(package, mismatch)
        path = mismatch / "manifest.json"
        mismatched = json.loads(path.read_text())
        mismatched["database"]["revision"] = wrong_revision
        path.write_text(json.dumps(mismatched), encoding="utf-8")
        target = tmp_path / f"rejected-{wrong_revision}"
        _failure(backup_cli("restore", mismatch, target))
        assert not target.exists()

    monkeypatch.delenv("FOLIO_TEST_INSTALLATION")
    rejected = tmp_path / "new-backup-rejected-by-old"
    _failure(backup_cli("restore", new_backup, rejected))
    assert not rejected.exists()
    rejected_backup = tmp_path / "new-database-rejected-by-old"
    _failure(backup_cli("create", rejected_backup))
    assert not rejected_backup.exists()
    assert _rows(database) == before
