"""Bounded derived dictionary indexes with transactional installation and selection.

Healthy indexes are immutable. Readers retain one read-only connection while the
library selects another dictionary; explicit reimport can repair a damaged index.
The original single-index file remains in place. No learning tables are touched.
"""

import asyncio
import hashlib
import json
import os
import re
import sqlite3
import tempfile
import unicodedata
import zipfile
import zlib
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager, closing
from dataclasses import dataclass, replace
from glob import escape
from pathlib import Path
from typing import Literal, cast
from uuid import uuid4

import aiosqlite
from fastapi import HTTPException

from app.dictionary_schemas import (
    DictionaryLibrary,
    DictionaryLibraryImport,
    DictionaryLibraryItem,
    DictionaryNode,
    DictionaryStatus,
)
from app.platform_io import fsync_directory
from app.services.dictionary_styles import StyleContext, sanitize_style
from app.services.dictionary_stylesheet import (
    MAX_STYLESHEET_BYTES,
    STRUCTURED_ROOT,
    DictionaryStylesheet,
    StyleNode,
    compile_stylesheet,
)

INDEX_VERSION = "2"
TREE_VERSION = "1"
STYLESHEET_INDEX_VERSION = 1
STYLESHEET_NAME = "styles.css"
MAX_UPLOAD_BYTES = 256 * 1024 * 1024
MAX_UNPACKED_BYTES = 1024 * 1024 * 1024
MAX_BANK_BYTES = 64 * 1024 * 1024
MAX_ENTRIES = 1_000_000
MAX_DEFINITION_BYTES = 4 * 1024 * 1024
MAX_LOADED_DEFINITION_BYTES = 16 * 1024 * 1024
MAX_INDEX_BYTES = 2 * 1024 * 1024 * 1024
MAX_QUERY_RECORDS = 20_000
BANK_NAME = re.compile(r"term_bank_(\d+)\.json\Z")
_INDEX_FILENAME = r"[0-9a-f]{64}(?:\.styles-\d+)?\.sqlite3"
LIBRARY_INDEX = re.compile(_INDEX_FILENAME)
STAGED_LIBRARY_INDEX = re.compile(rf"({_INDEX_FILENAME})\.deleting-[0-9a-f]{{32}}")
NodeTag = Literal["div", "p", "span", "ul", "ol", "li", "br", "ruby", "rt"]
NodeRole = Literal["head", "def1", "def2", "dfcn", "exam", "exjp", "excn"]
NODE_TAGS = {"div", "p", "span", "ul", "ol", "li", "br", "ruby", "rt"}
NODE_ROLES = {"head", "def1", "def2", "dfcn", "exam", "exjp", "excn"}


def _search_key(value: str) -> str:
    return "".join(
        chr(ord(character) - 0x60) if "ァ" <= character <= "ヶ" else character
        for character in unicodedata.normalize("NFKC", value)
    )


def _invalid(
    detail: str = "无法导入此文件，请选择 Yomitan 第 3 版词条词典的 ZIP 文件",
) -> HTTPException:
    return HTTPException(status_code=422, detail=detail)


def _object(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise _invalid()
    return cast(dict[str, object], value)


def _array(value: object) -> list[object]:
    if not isinstance(value, list):
        raise _invalid()
    return cast(list[object], value)


def _string(value: object, max_length: int = 4096) -> str:
    if not isinstance(value, str) or len(value) > max_length:
        raise _invalid()
    return unicodedata.normalize("NFC", value)


def _nodes(
    value: object,
    depth: int = 0,
    context: StyleContext | None = None,
    stylesheet: DictionaryStylesheet | None = None,
    ancestors: tuple[StyleNode, ...] = (),
) -> list[DictionaryNode]:
    context = context or StyleContext()
    if depth > 40:
        raise _invalid("词典释义的嵌套层级超过限制")
    if isinstance(value, str):
        return [DictionaryNode(text=_string(value, 1_000_000))]
    if isinstance(value, list):
        return [
            node
            for item in cast(list[object], value)
            for node in _nodes(item, depth + 1, context, stylesheet, ancestors)
        ]
    item = _object(value)
    if item.get("type") == "structured-content":
        root = (STRUCTURED_ROOT,) if stylesheet is not None else ()
        return _nodes(item.get("content", ""), depth + 1, context, stylesheet, root)
    if item.get("type") == "text":
        return _nodes(item.get("text", ""), depth + 1, context, stylesheet, ancestors)
    # Unsupported image/audio resources are never fetched or interpreted as HTML.
    if item.get("type") in {"image", "audio"}:
        return []
    raw_tag = item.get("tag")
    tag = raw_tag if isinstance(raw_tag, str) else "span"
    if tag in {"script", "style", "iframe", "object", "img"}:
        return []
    safe_tag = cast(NodeTag, tag if tag in NODE_TAGS else "span")
    raw_data = item.get("data")
    data = _object(cast(object, raw_data)) if isinstance(raw_data, dict) else {}
    role_value = data.get("class")
    role = cast(
        NodeRole | None,
        role_value if isinstance(role_value, str) and role_value in NODE_ROLES else None,
    )
    language = item.get("lang")
    lang: Literal["ja", "zh"] | None = None
    if isinstance(language, str):
        lang = "zh" if language.startswith("zh") else "ja" if language.startswith("ja") else None
    if role in {"dfcn", "excn"}:
        lang = "zh"
    elif role == "exjp":
        lang = "ja"
    raw_style = item.get("style")
    if stylesheet is not None:
        ancestors = (
            *ancestors,
            StyleNode(tag, data, language if isinstance(language, str) else None),
        )
        raw_style = stylesheet.style_for(ancestors, raw_style)
    style, child_context = sanitize_style(raw_style, context)
    return [
        DictionaryNode(
            tag=safe_tag,
            lang=lang,
            role=role,
            style=style,
            content=_nodes(
                item.get("content", ""), depth + 1, child_context, stylesheet, ancestors
            ),
        )
    ]


@dataclass(frozen=True)
class DictionaryEntry:
    id: int
    dictionary_id: str
    term: str
    reading: str
    rules: str
    sequence: int | None
    definitions: tuple[DictionaryNode, ...]
    order: int
    definition_tags: str = ""
    term_tags: str = ""
    score: int = 0
    definition_id: str = ""


def _entry(row: tuple[object, ...]) -> DictionaryEntry:
    return DictionaryEntry(
        id=int(cast(int, row[0])),
        dictionary_id=cast(str, row[1]),
        term=cast(str, row[2]),
        reading=cast(str, row[3]),
        rules=cast(str, row[4]),
        sequence=cast(int | None, row[5]),
        definitions=(),
        definition_id=cast(str, row[6]),
        order=int(cast(int, row[0])),
        definition_tags=cast(str, row[7]),
        term_tags=cast(str, row[8]),
        score=int(cast(int, row[9])),
    )


class DictionarySnapshot:
    def __init__(self, connection: aiosqlite.Connection | None) -> None:
        self.connection = connection
        self._definitions: dict[str, tuple[DictionaryNode, ...]] = {}
        self._definition_bytes = 0
        self._stylesheet: DictionaryStylesheet | None = None
        self._loaded_stylesheet = False

    async def status(self) -> DictionaryStatus:
        if self.connection is None:
            return DictionaryStatus()
        async with self.connection.execute(
            "SELECT title, dictionary_id, revision, entry_count, version FROM metadata"
        ) as cursor:
            row = await cursor.fetchone()
        if row is None or row[4] != INDEX_VERSION:
            return DictionaryStatus()
        return DictionaryStatus(
            title=row[0], dictionary_id=row[1], revision=row[2], entry_count=row[3], ready=True
        )

    async def has_current_stylesheet_index(self) -> bool:
        if self.connection is None:
            return False
        async with self.connection.execute("PRAGMA user_version") as cursor:
            row = await cursor.fetchone()
        return row is not None and row[0] >= STYLESHEET_INDEX_VERSION

    async def _read_stylesheet_source(self) -> str | None:
        if self.connection is None:
            return None
        try:
            async with self.connection.execute(
                "SELECT source FROM stylesheet WHERE length(CAST(source AS BLOB)) <= ? LIMIT 1",
                (MAX_STYLESHEET_BYTES,),
            ) as cursor:
                row = await cursor.fetchone()
        except aiosqlite.OperationalError as exc:
            if str(exc) != "no such table: stylesheet":
                raise
            return None
        return str(row[0]) if row is not None else None

    async def find_terms(self, keys: list[str]) -> list[DictionaryEntry]:
        if self.connection is None or not keys:
            return []
        values = list(dict.fromkeys(_search_key(key) for key in keys))
        if len(values) > 4096:
            raise _invalid("匹配词条过多，请缩短查询文字")
        entries: dict[int, DictionaryEntry] = {}
        for offset in range(0, len(values), 400):
            batch = values[offset : offset + 400]
            placeholders = ",".join("?" for _ in batch)
            sql = (
                f"SELECT * FROM entries WHERE term_key IN ({placeholders}) "
                f"OR reading_key IN ({placeholders}) ORDER BY id LIMIT ?"
            )
            async with self.connection.execute(
                sql, [*batch, *batch, MAX_QUERY_RECORDS + 1]
            ) as cursor:
                for row in await cursor.fetchall():
                    entry = _entry(tuple(row))
                    entries[entry.id] = entry
            if len(entries) > MAX_QUERY_RECORDS:
                raise _invalid("查询结果超过限制，请缩小选区")
        return sorted(entries.values(), key=lambda entry: entry.order)

    async def get_sequences(self, keys: list[tuple[str, int]]) -> list[DictionaryEntry]:
        if self.connection is None or not keys:
            return []
        if len(keys) > 100:
            raise _invalid("匹配词条过多，请缩短查询文字")
        clauses = " OR ".join("(dictionary_id = ? AND sequence = ?)" for _ in keys)
        parameters = [value for key in keys for value in key]
        async with self.connection.execute(
            f"SELECT * FROM entries WHERE {clauses} ORDER BY id LIMIT ?",
            [*parameters, MAX_QUERY_RECORDS + 1],
        ) as cursor:
            rows = list(await cursor.fetchall())
        if len(rows) > MAX_QUERY_RECORDS:
            raise _invalid("匹配词条过多，请缩短查询文字")
        return [_entry(tuple(row)) for row in rows]

    async def load_definitions(self, entries: list[DictionaryEntry]) -> list[DictionaryEntry]:
        """Decode only displayed cards, once per shared definition and query snapshot."""
        if self.connection is None:
            return entries
        missing = list(
            dict.fromkeys(
                entry.definition_id
                for entry in entries
                if entry.definition_id and entry.definition_id not in self._definitions
            )
        )
        for offset in range(0, len(missing), 32):
            batch = missing[offset : offset + 32]
            placeholders = ",".join("?" for _ in batch)
            async with self.connection.execute(
                f"SELECT id, payload FROM definitions WHERE id IN ({placeholders})", batch
            ) as cursor:
                rows = [(str(row[0]), bytes(row[1])) for row in await cursor.fetchall()]
            decoded, stale, size = await asyncio.to_thread(
                _decode_definitions, rows, MAX_LOADED_DEFINITION_BYTES - self._definition_bytes
            )
            if stale:
                # Fresh trees never consult the retained stylesheet. When an older
                # tree needs rebuilding, parse the stylesheet once for this snapshot.
                if not self._loaded_stylesheet:
                    source = await self._read_stylesheet_source()
                    self._stylesheet = await asyncio.to_thread(compile_stylesheet, source)
                    self._loaded_stylesheet = True
                decoded.update(
                    await asyncio.to_thread(_rebuild_definitions, stale, self._stylesheet)
                )
            self._definitions.update(decoded)
            self._definition_bytes += size
        return [
            replace(
                entry, definitions=self._definitions.get(entry.definition_id, entry.definitions)
            )
            for entry in entries
        ]


def _decode_definitions(
    rows: list[tuple[str, bytes]], budget: int
) -> tuple[dict[str, tuple[DictionaryNode, ...]], dict[str, object], int]:
    decoded: dict[str, tuple[DictionaryNode, ...]] = {}
    stale: dict[str, object] = {}
    size = 0
    for identity, payload in rows:
        decoder = zlib.decompressobj()
        try:
            raw = decoder.decompress(payload, min(MAX_DEFINITION_BYTES, budget - size) + 1)
        except zlib.error as exc:
            raise _invalid("无法读取词典释义，请重新导入该词典") from exc
        size += len(raw)
        if len(raw) > MAX_DEFINITION_BYTES or size > budget or not decoder.eof:
            raise _invalid("无法读取词典释义，请重新导入该词典")
        envelope = _object(json.loads(raw))
        if envelope.get("tree_version") == TREE_VERSION:
            decoded[identity] = tuple(
                DictionaryNode.model_validate(node) for node in _array(envelope["nodes"])
            )
        else:
            stale[identity] = envelope["source"]
    return decoded, stale, size


def _rebuild_definitions(
    stale: dict[str, object], stylesheet: DictionaryStylesheet | None
) -> dict[str, tuple[DictionaryNode, ...]]:
    return {
        identity: tuple(_nodes(source, stylesheet=stylesheet)) for identity, source in stale.items()
    }


class DictionaryStore:
    """Immutable indexes with one transactional library and active selection.

    The original single index remains in place and is exposed without reimport.
    Catalog commits only reference complete files. Healthy indexes are never replaced.
    Open readers retain their exact dictionary; busy files are reclaimed after readers close.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self.library_path = path.with_name(path.name + ".library")
        self.catalog_path = self.library_path / "catalog.sqlite3"
        self._import_lock = asyncio.Lock()
        self._deferred_deletions: dict[Path, Path] = {}

    @asynccontextmanager
    async def _file_snapshot(self, path: Path) -> AsyncGenerator[DictionarySnapshot]:
        try:
            # A process interrupted between staging a deletion and catalog commit
            # leaves the old generation readable until its next mutation.
            candidate = await asyncio.to_thread(self.readable_index_path, path)
            resolved = await asyncio.to_thread(candidate.resolve)
            connection = await aiosqlite.connect(resolved.as_uri() + "?mode=ro", uri=True)
        except aiosqlite.OperationalError:
            yield DictionarySnapshot(None)
            return
        try:
            snapshot = DictionarySnapshot(connection)
            try:
                ready = (await snapshot.status()).ready
            except aiosqlite.DatabaseError:
                ready = False
            yield snapshot if ready else DictionarySnapshot(None)
        finally:
            await connection.close()

    async def _legacy_status(self) -> DictionaryStatus:
        async with self._file_snapshot(self.path) as snapshot:
            return await snapshot.status()

    async def _legacy_library(self) -> tuple[DictionaryLibrary, dict[str, Path]]:
        legacy = await self._legacy_status()
        if not legacy.ready or not legacy.dictionary_id:
            return DictionaryLibrary(dictionaries=[], active_dictionary_id=None), {}
        item = DictionaryLibraryItem(
            dictionary_id=legacy.dictionary_id,
            title=legacy.title or "",
            revision=legacy.revision or "",
            entry_count=legacy.entry_count,
        )
        return (
            DictionaryLibrary(dictionaries=[item], active_dictionary_id=item.dictionary_id),
            {item.dictionary_id: self.path},
        )

    @staticmethod
    def readable_index_path(path: Path) -> Path:
        if path.exists():
            return path
        return next(path.parent.glob(escape(path.name) + ".deleting-*"), path)

    @staticmethod
    def _retained_paths(path: Path) -> list[Path]:
        return list(path.parent.glob(escape(path.name) + ".deleting-*"))

    @staticmethod
    def _deleting_path(path: Path) -> Path:
        return path.with_name(path.name + ".deleting-" + uuid4().hex)

    def _staged_indexes(self) -> dict[Path, Path]:
        """Map only names produced by deletion back to their catalog index paths."""
        staged = {
            path: self.path
            for path in self._retained_paths(self.path)
            if re.fullmatch(r"[0-9a-f]{32}", path.name.removeprefix(self.path.name + ".deleting-"))
        }
        for path in self.library_path.glob("*.sqlite3.deleting-*"):
            match = STAGED_LIBRARY_INDEX.fullmatch(path.name)
            if match is not None:
                staged[path] = self.library_path / match[1]
        return staged

    @asynccontextmanager
    async def _catalog_view(
        self,
    ) -> AsyncGenerator[tuple[DictionaryLibrary, dict[str, Path]]]:
        try:
            connection = await aiosqlite.connect(
                self.catalog_path.resolve().as_uri() + "?mode=ro", uri=True
            )
        except aiosqlite.OperationalError:
            yield await self._legacy_library()
            return
        try:
            # Both reads observe the same committed catalog generation.
            await connection.execute("BEGIN")
            yield await self._read_catalog(connection)
        except aiosqlite.OperationalError as exc:
            # A concurrent first writer has created the catalog file but has not
            # committed its schema yet, or its first transaction rolled back.
            if "no such table" not in str(exc):
                raise
            yield await self._legacy_library()
            return
        finally:
            await connection.close()

    async def _read_catalog(
        self, connection: aiosqlite.Connection
    ) -> tuple[DictionaryLibrary, dict[str, Path]]:
        async with connection.execute(
            "SELECT dictionary_id, title, revision, entry_count, filename "
            "FROM dictionaries ORDER BY rowid"
        ) as cursor:
            rows = await cursor.fetchall()
        async with connection.execute("SELECT dictionary_id FROM active") as cursor:
            active = await cursor.fetchone()
        return (
            DictionaryLibrary(
                dictionaries=[
                    DictionaryLibraryItem(
                        dictionary_id=row[0], title=row[1], revision=row[2], entry_count=row[3]
                    )
                    for row in rows
                ],
                active_dictionary_id=str(active[0]) if active else None,
            ),
            {
                str(row[0]): self.path if row[4] == "legacy" else self.library_path / row[4]
                for row in rows
            },
        )

    async def _catalog(self) -> tuple[DictionaryLibrary, dict[str, Path]]:
        async with self._catalog_view() as view:
            return view

    async def library(self) -> DictionaryLibrary:
        library, _ = await self._catalog()
        return library

    @asynccontextmanager
    async def snapshot(self) -> AsyncGenerator[DictionarySnapshot]:
        # Hold the tiny catalog read transaction only until the index connection
        # is open. Deletion takes an exclusive catalog lock before moving files.
        try:
            async with AsyncExitStack() as stack:
                async with self._catalog_view() as (library, paths):
                    path = (
                        paths.get(library.active_dictionary_id)
                        if library.active_dictionary_id
                        else None
                    )
                    snapshot = (
                        await stack.enter_async_context(self._file_snapshot(path))
                        if path is not None
                        else DictionarySnapshot(None)
                    )
                    status = await snapshot.status()
                yield (
                    snapshot
                    if status.dictionary_id == library.active_dictionary_id
                    else DictionarySnapshot(None)
                )
        finally:
            if self._deferred_deletions:
                await self._cleanup_deferred_indexes()

    async def _reap_unreferenced_indexes(self, connection: aiosqlite.Connection) -> None:
        """Run under the catalog write lock so reimport cannot race file cleanup."""
        _, paths = await self._read_catalog(connection)
        referenced = set(paths.values())
        candidates = self._deferred_deletions.copy()
        for path in self.library_path.glob("*.sqlite3"):
            if LIBRARY_INDEX.fullmatch(path.name):
                candidates[path] = path
        if self.path not in referenced:
            # A restart loses the in-memory queue for a busy legacy deletion.
            # Only recognize healthy old indexes; unknown damaged files stay intact.
            legacy = await self._legacy_status()
            if legacy.ready and legacy.dictionary_id:
                candidates[self.path] = self.path
        candidates.update(await asyncio.to_thread(self._staged_indexes))
        for path, catalog_path in candidates.items():
            if path in referenced or catalog_path in referenced:
                self._deferred_deletions.pop(path, None)
                continue
            try:
                await asyncio.to_thread(path.unlink, missing_ok=True)
            except OSError:
                # Windows readers (or another local program) still hold the file.
                self._deferred_deletions[path] = catalog_path
            else:
                self._deferred_deletions.pop(path, None)

    async def _cleanup_deferred_indexes(self) -> None:
        try:
            async with aiosqlite.connect(self.catalog_path) as connection:
                await connection.execute("PRAGMA busy_timeout = 30000")
                await connection.execute("BEGIN EXCLUSIVE")
                await self._reap_unreferenced_indexes(connection)
                await connection.commit()
        except (aiosqlite.Error, OSError):
            # Reclamation must not turn a committed deletion or completed lookup
            # into an apparent failure. A later reader/mutation retries it.
            pass

    async def status(self) -> DictionaryStatus:
        async with self.snapshot() as snapshot:
            return await snapshot.status()

    async def find_terms(self, keys: list[str]) -> list[DictionaryEntry]:
        async with self.snapshot() as snapshot:
            return await snapshot.load_definitions(await snapshot.find_terms(keys))

    async def get_sequences(self, keys: list[tuple[str, int]]) -> list[DictionaryEntry]:
        async with self.snapshot() as snapshot:
            return await snapshot.load_definitions(await snapshot.get_sequences(keys))

    async def _write_catalog(
        self,
        installed: DictionaryStatus | None = None,
        active_id: str | None = None,
        prepared_index: Path | None = None,
    ) -> tuple[DictionaryLibrary, bool]:
        self.library_path.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(self.catalog_path) as connection:
            await connection.execute("PRAGMA busy_timeout = 30000")
            await connection.execute("BEGIN EXCLUSIVE")
            async with connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='dictionaries'"
            ) as cursor:
                initialized = await cursor.fetchone() is not None
            legacy = await self._legacy_status() if not initialized else DictionaryStatus()
            await connection.execute(
                "CREATE TABLE IF NOT EXISTS dictionaries(dictionary_id TEXT PRIMARY KEY, "
                "title TEXT NOT NULL, revision TEXT NOT NULL, entry_count INTEGER NOT NULL, "
                "filename TEXT NOT NULL)"
            )
            await connection.execute(
                "CREATE TABLE IF NOT EXISTS active("
                "singleton INTEGER PRIMARY KEY CHECK(singleton=1), dictionary_id TEXT NOT NULL)"
            )
            async with connection.execute("SELECT count(*) FROM dictionaries") as cursor:
                row = await cursor.fetchone()
            count = int(row[0]) if row else 0
            if not initialized and legacy.ready and legacy.dictionary_id:
                await connection.execute(
                    "INSERT INTO dictionaries VALUES (?, ?, ?, ?, 'legacy')",
                    (legacy.dictionary_id, legacy.title, legacy.revision, legacy.entry_count),
                )
                await connection.execute(
                    "INSERT INTO active VALUES (1, ?)", (legacy.dictionary_id,)
                )
                count = 1
            await self._reap_unreferenced_indexes(connection)
            already_installed = False
            replaced_path: Path | None = None
            if installed is not None and installed.dictionary_id:
                async with connection.execute(
                    "SELECT filename FROM dictionaries WHERE dictionary_id = ?",
                    (installed.dictionary_id,),
                ) as cursor:
                    current = await cursor.fetchone()
                already_installed = current is not None
                if current is None and prepared_index is None:
                    raise HTTPException(
                        status_code=409, detail="已安装的词典发生变化，请重新导入该词典"
                    )
                if prepared_index is not None:
                    current_path = None
                    if current is not None:
                        current_path = (
                            self.path if current[0] == "legacy" else self.library_path / current[0]
                        )
                    chosen = await asyncio.to_thread(
                        self._publish_index, prepared_index, installed, current_path
                    )
                    filename = "legacy" if chosen == self.path else chosen.name
                    await connection.execute(
                        "INSERT INTO dictionaries VALUES (?, ?, ?, ?, ?) "
                        "ON CONFLICT(dictionary_id) DO UPDATE SET filename = excluded.filename",
                        (
                            installed.dictionary_id,
                            installed.title,
                            installed.revision,
                            installed.entry_count,
                            filename,
                        ),
                    )
                    if current_path is not None and current_path not in {chosen, self.path}:
                        replaced_path = current_path
                if count == 0:
                    active_id = installed.dictionary_id
            if active_id is not None:
                async with connection.execute(
                    "SELECT filename FROM dictionaries WHERE dictionary_id = ?", (active_id,)
                ) as cursor:
                    found = await cursor.fetchone()
                if not found:
                    raise _invalid("所选词典尚未安装，请重新选择")
                selected_path = self.path if found[0] == "legacy" else self.library_path / found[0]
                async with self._file_snapshot(selected_path) as snapshot:
                    selected = await snapshot.status()
                if not selected.ready or selected.dictionary_id != active_id:
                    raise _invalid("无法读取所选词典，请重新导入该词典")
                await connection.execute(
                    "INSERT OR REPLACE INTO active VALUES (1, ?)", (active_id,)
                )
            library, _ = await self._read_catalog(connection)
            await connection.commit()
            if replaced_path is not None:
                self._deferred_deletions[replaced_path] = replaced_path
        return library, already_installed

    async def select(self, dictionary_id: str) -> DictionaryLibrary:
        library, _ = await self._write_catalog(active_id=dictionary_id)
        return library

    async def import_stream(self, chunks: AsyncIterator[bytes]) -> DictionaryStatus:
        result = await self._import(chunks, activate=True)
        item = next(
            item
            for item in result.library.dictionaries
            if item.dictionary_id == result.dictionary_id
        )
        return DictionaryStatus(**item.model_dump(), ready=True)

    async def import_library_stream(self, chunks: AsyncIterator[bytes]) -> DictionaryLibraryImport:
        return await self._import(chunks, activate=False)

    async def _import(
        self, chunks: AsyncIterator[bytes], *, activate: bool
    ) -> DictionaryLibraryImport:
        async with self._import_lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, raw_path = tempfile.mkstemp(
                prefix=".dictionary-upload-", suffix=".zip", dir=self.path.parent
            )
            source = Path(raw_path)
            try:
                size = 0
                with os.fdopen(fd, "wb") as output:
                    async for chunk in chunks:
                        size += len(chunk)
                        if size > MAX_UPLOAD_BYTES:
                            raise HTTPException(
                                status_code=413, detail="词典 ZIP 文件不能超过 256 MB"
                            )
                        await asyncio.to_thread(output.write, chunk)
                task = asyncio.create_task(self._install(source, activate))
                try:
                    return await asyncio.shield(task)
                except asyncio.CancelledError:
                    # Keep the upload and publisher lock alive through catalog commit.
                    await task
                    raise
            finally:
                await asyncio.to_thread(source.unlink, missing_ok=True)

    async def _install(self, source: Path, activate: bool) -> DictionaryLibraryImport:
        def digest_source() -> str:
            with source.open("rb") as uploaded:
                return hashlib.file_digest(uploaded, "sha256").hexdigest()

        identity = await asyncio.to_thread(digest_source)
        library, paths = await self._catalog()
        existing = next(
            (item for item in library.dictionaries if item.dictionary_id == identity), None
        )
        valid = False
        if existing:
            async with self._file_snapshot(paths[identity]) as snapshot:
                status = await snapshot.status()
                valid = status.ready and status.dictionary_id == identity
                has_current_stylesheet_index = (
                    valid and await snapshot.has_current_stylesheet_index()
                )
            if valid and not has_current_stylesheet_index:
                valid = not await asyncio.to_thread(_archive_contains_stylesheet, source)
        prepared: Path | None = None
        try:
            if existing and valid:
                result = DictionaryStatus(**existing.model_dump(), ready=True)
            else:
                result, prepared = await asyncio.to_thread(self._build_index, source)
            library, already_installed = await self._write_catalog(
                installed=result,
                active_id=result.dictionary_id if activate else None,
                prepared_index=prepared,
            )
            if self._deferred_deletions:
                await self._cleanup_deferred_indexes()
            return DictionaryLibraryImport(
                library=library, dictionary_id=identity, already_installed=already_installed
            )
        finally:
            if prepared is not None:
                await asyncio.to_thread(prepared.unlink, missing_ok=True)

    def _build_index(self, source: Path) -> tuple[DictionaryStatus, Path]:
        self.library_path.mkdir(parents=True, exist_ok=True)
        fd, raw_path = tempfile.mkstemp(
            prefix=".dictionary-index-", suffix=".sqlite3", dir=self.library_path
        )
        os.close(fd)
        target = Path(raw_path)
        try:
            result = _build(source, target)
            with target.open("r+b") as completed:
                os.fsync(completed.fileno())
            return result, target
        except (
            zipfile.BadZipFile,
            KeyError,
            ValueError,
            TypeError,
            RecursionError,
            UnicodeError,
            RuntimeError,
            sqlite3.Error,
            zlib.error,
        ) as exc:
            target.unlink(missing_ok=True)
            raise _invalid() from exc
        except BaseException:
            target.unlink(missing_ok=True)
            raise

    def _publish_index(
        self, target: Path, result: DictionaryStatus, current_path: Path | None
    ) -> Path:
        published = self.library_path / (str(result.dictionary_id) + ".sqlite3")
        base_is_older = False
        if current_path is not None:
            readable = self.readable_index_path(current_path)
            healthy, styled = _index_presentation_status(readable, result.dictionary_id)
            if styled:
                return current_path
            base_is_older = current_path == published and healthy

        # A styled rebuild must not change the file behind readers of the healthy
        # old index. It can still be open after deletion has removed the catalog entry.
        if not base_is_older and current_path != published and published.is_file():
            healthy, styled = _index_presentation_status(published, result.dictionary_id)
            base_is_older = healthy and not styled
        if base_is_older:
            published = published.with_suffix(f".styles-{STYLESHEET_INDEX_VERSION}.sqlite3")
        try:
            os.link(target, published)
        except FileExistsError:
            if not _index_presentation_status(published, result.dictionary_id)[1]:
                os.replace(target, published)
        fsync_directory(self.library_path)
        return published

    async def delete(
        self, dictionary_id: str, replacement_dictionary_id: str | None = None
    ) -> DictionaryLibrary:
        # Bootstrap legacy state once. An initialized empty catalog is authoritative
        # and must never rediscover a deleted legacy dictionary.
        await self._write_catalog()
        task = asyncio.create_task(self._delete(dictionary_id, replacement_dictionary_id))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            await task
            raise

    async def _delete(
        self, dictionary_id: str, replacement_dictionary_id: str | None
    ) -> DictionaryLibrary:
        staged: list[tuple[Path, Path]] = []
        cleanup: dict[Path, Path] = {}
        async with aiosqlite.connect(self.catalog_path) as connection:
            await connection.execute("PRAGMA busy_timeout = 30000")
            await connection.execute("BEGIN EXCLUSIVE")
            try:
                async with connection.execute(
                    "SELECT dictionary_id, filename FROM dictionaries"
                ) as cursor:
                    rows = {str(row[0]): str(row[1]) for row in await cursor.fetchall()}
                if dictionary_id not in rows:
                    raise HTTPException(
                        status_code=404, detail="词典已删除或尚未安装，请刷新词典列表"
                    )
                async with connection.execute("SELECT dictionary_id FROM active") as cursor:
                    active = await cursor.fetchone()
                is_active = active is not None and active[0] == dictionary_id
                if replacement_dictionary_id is not None:
                    if not is_active or replacement_dictionary_id == dictionary_id:
                        raise _invalid("替代词典仅用于删除当前词典，请重新选择")
                    filename = rows.get(replacement_dictionary_id)
                    if filename is None:
                        raise _invalid("替代词典尚未安装，请重新选择")
                    path = self.path if filename == "legacy" else self.library_path / filename
                    async with self._file_snapshot(path) as snapshot:
                        status = await snapshot.status()
                    if not status.ready or status.dictionary_id != replacement_dictionary_id:
                        raise _invalid("无法读取替代词典，请重新导入该词典")
                elif is_active and len(rows) > 1:
                    raise _invalid("删除当前词典前请选择替代词典")
                if is_active:
                    await connection.execute("DELETE FROM active")
                    if replacement_dictionary_id is not None:
                        await connection.execute(
                            "INSERT INTO active VALUES (1, ?)", (replacement_dictionary_id,)
                        )
                await connection.execute(
                    "DELETE FROM dictionaries WHERE dictionary_id = ?", (dictionary_id,)
                )
                filename = rows[dictionary_id]
                paths = {self.library_path / (dictionary_id + ".sqlite3")}
                if filename == "legacy":
                    paths.add(self.path)
                else:
                    paths.add(self.library_path / filename)
                # Also remove a repaired legacy original with the same identity.
                legacy = await self._legacy_status()
                if legacy.dictionary_id == dictionary_id:
                    paths.add(self.path)
                for path in paths:
                    # Old committed cleanup failures and interrupted staging use
                    # unique names. Only the current file participates in rollback.
                    for retained in await asyncio.to_thread(self._retained_paths, path):
                        cleanup[retained] = path
                    retained = self._deleting_path(path)
                    if await asyncio.to_thread(path.exists):
                        try:
                            await asyncio.to_thread(os.replace, path, retained)
                        except PermissionError:
                            # Windows cannot rename an open SQLite file. The
                            # committed catalog hides it; close/mutation retries
                            # cleanup while holding the catalog write lock.
                            self._deferred_deletions[path] = path
                        else:
                            staged.append((path, retained))
                            cleanup[retained] = path
                    else:
                        recovered = await asyncio.to_thread(self.readable_index_path, path)
                        if recovered != path:
                            staged.append((path, recovered))
                library, _ = await self._read_catalog(connection)
                await connection.commit()
            except BaseException:
                try:
                    # Keep the directory lock through restoration so another
                    # publisher cannot race rollback and have its file overwritten.
                    for path, retained in reversed(staged):
                        await asyncio.to_thread(os.replace, retained, path)
                finally:
                    await connection.rollback()
                raise
        for retained, original in cleanup.items():
            try:
                await asyncio.to_thread(retained.unlink, missing_ok=True)
            except OSError:
                self._deferred_deletions[retained] = original
        if self._deferred_deletions:
            await self._cleanup_deferred_indexes()
        return library


def _index_presentation_status(path: Path, identity: str | None) -> tuple[bool, bool]:
    try:
        with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as connection:
            metadata = connection.execute("SELECT dictionary_id, version FROM metadata").fetchone()
            styled = connection.execute("PRAGMA user_version").fetchone()[0]
    except sqlite3.DatabaseError:
        return False, False
    healthy = metadata == (identity, INDEX_VERSION)
    return healthy, healthy and styled >= STYLESHEET_INDEX_VERSION


def _archive_contains_stylesheet(source: Path) -> bool:
    with zipfile.ZipFile(source) as archive:
        return STYLESHEET_NAME in archive.NameToInfo


def _read_stylesheet(archive: zipfile.ZipFile) -> str | None:
    info = archive.NameToInfo.get(STYLESHEET_NAME)
    if info is None or info.file_size > MAX_STYLESHEET_BYTES:
        return None
    try:
        return archive.read(info).decode("utf-8-sig")
    except UnicodeDecodeError:
        return None


def _build(source: Path, target: Path) -> DictionaryStatus:
    with source.open("rb") as uploaded:
        digest = hashlib.file_digest(uploaded, "sha256").hexdigest()
    with zipfile.ZipFile(source) as archive, closing(sqlite3.connect(target)) as connection:
        files = archive.infolist()
        if len(files) > 4096 or len({item.filename for item in files}) != len(files):
            raise _invalid()
        if sum(item.file_size for item in files) > MAX_UNPACKED_BYTES:
            raise _invalid("词典解压后体积超过限制")
        for item in files:
            if item.flag_bits & 1 or item.file_size > MAX_BANK_BYTES:
                raise _invalid("词典 ZIP 中含有过大或加密的文件")
            if item.file_size > 1_000_000 and item.file_size > max(item.compress_size, 1) * 1000:
                raise _invalid("词典压缩比例超过限制")
        index = _object(json.loads(archive.read("index.json")))
        if type(index.get("format")) is not int or index["format"] != 3:
            raise _invalid()
        title = _string(index.get("title"))
        revision = _string(index.get("revision", ""))
        if not title.strip():
            raise _invalid()
        banks = sorted(
            (item for item in files if BANK_NAME.fullmatch(item.filename)),
            key=lambda item: int(cast(re.Match[str], BANK_NAME.fullmatch(item.filename))[1]),
        )
        if not banks:
            raise _invalid("词典 ZIP 中缺少词条文件")
        connection.executescript("""
            CREATE TABLE metadata(title TEXT, dictionary_id TEXT, revision TEXT,
                entry_count INTEGER, version TEXT);
            CREATE TABLE entries(id INTEGER PRIMARY KEY, dictionary_id TEXT NOT NULL,
                term TEXT NOT NULL,
                reading TEXT NOT NULL, rules TEXT NOT NULL, sequence INTEGER,
                definition_id TEXT NOT NULL,
                definition_tags TEXT NOT NULL, term_tags TEXT NOT NULL, score INTEGER NOT NULL,
                original TEXT NOT NULL, term_key TEXT NOT NULL, reading_key TEXT NOT NULL);
        """)
        connection.execute("CREATE TABLE definitions(id TEXT PRIMARY KEY, payload BLOB NOT NULL)")
        connection.execute("CREATE TABLE stylesheet(source TEXT NOT NULL)")
        connection.execute(f"PRAGMA user_version = {STYLESHEET_INDEX_VERSION}")
        stylesheet_source = _read_stylesheet(archive)
        stylesheet = compile_stylesheet(stylesheet_source)
        if stylesheet_source is not None:
            connection.execute("INSERT INTO stylesheet VALUES (?)", (stylesheet_source,))
        seen_definitions: set[str] = set()
        count = 0
        for bank in banks:
            records = _array(json.loads(archive.read(bank)))
            for raw in records:
                record = _array(raw)
                if len(record) != 8:
                    raise _invalid()
                term, reading = _string(record[0]), _string(record[1])
                definition_tags, rules, term_tags = (
                    _string(record[2]),
                    _string(record[3]),
                    _string(record[7]),
                )
                if not term or type(record[4]) is not int or not -(2**63) <= record[4] < 2**63:
                    raise _invalid()
                sequence = record[6] if type(record[6]) is int and 0 <= record[6] < 2**63 else None
                source_definitions = json.dumps(
                    _array(record[5]), ensure_ascii=False, sort_keys=True, separators=(",", ":")
                ).encode("utf-8")
                if len(source_definitions) > MAX_DEFINITION_BYTES // 4:
                    raise _invalid("单个词条的释义超过大小限制")
                definition_id = hashlib.sha256(source_definitions).hexdigest()
                if definition_id not in seen_definitions:
                    definitions = _nodes(record[5], stylesheet=stylesheet)
                    envelope = json.dumps(
                        {
                            "source": record[5],
                            "tree_version": TREE_VERSION,
                            "nodes": [
                                node.model_dump(exclude_none=True, exclude_defaults=True)
                                for node in definitions
                            ],
                        },
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ).encode("utf-8")
                    if len(envelope) > MAX_DEFINITION_BYTES:
                        raise _invalid("单个词条的释义超过大小限制")
                    connection.execute(
                        "INSERT INTO definitions VALUES (?, ?)",
                        (definition_id, zlib.compress(envelope)),
                    )
                    seen_definitions.add(definition_id)
                count += 1
                if count > MAX_ENTRIES:
                    raise _invalid("词典条目数量超过限制")
                connection.execute(
                    "INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        count,
                        digest,
                        term,
                        reading,
                        rules,
                        sequence,
                        definition_id,
                        definition_tags,
                        term_tags,
                        record[4],
                        json.dumps(
                            record[:5] + record[6:], ensure_ascii=False, separators=(",", ":")
                        ),
                        _search_key(term),
                        _search_key(reading),
                    ),
                )
                if count % 1000 == 0:
                    _check_index_budget(connection)
        if not count:
            raise _invalid("词典中没有可导入的词条")
        connection.executescript("""
            CREATE INDEX entries_term ON entries(term_key);
            CREATE INDEX entries_reading ON entries(reading_key);
            CREATE INDEX entries_sequence ON entries(dictionary_id, sequence);
        """)
        connection.execute(
            "INSERT INTO metadata VALUES (?, ?, ?, ?, ?)",
            (title, digest, revision, count, INDEX_VERSION),
        )
        _check_index_budget(connection)
        connection.commit()
    return DictionaryStatus(
        title=title, dictionary_id=digest, revision=revision, entry_count=count, ready=True
    )


def _check_index_budget(connection: sqlite3.Connection) -> None:
    pages = int(connection.execute("PRAGMA page_count").fetchone()[0])
    page_size = int(connection.execute("PRAGMA page_size").fetchone()[0])
    if pages * page_size > MAX_INDEX_BYTES:
        raise _invalid("词典导入后体积超过限制")
