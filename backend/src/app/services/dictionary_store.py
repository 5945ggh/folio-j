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
from contextlib import asynccontextmanager, closing
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Literal, cast

import aiosqlite
from fastapi import HTTPException

from app.dictionary_schemas import (
    DictionaryLibrary,
    DictionaryLibraryImport,
    DictionaryLibraryItem,
    DictionaryNode,
    DictionaryStatus,
)
from app.services.dictionary_styles import StyleContext, sanitize_style

INDEX_VERSION = "2"
TREE_VERSION = "1"
MAX_UPLOAD_BYTES = 256 * 1024 * 1024
MAX_UNPACKED_BYTES = 1024 * 1024 * 1024
MAX_BANK_BYTES = 64 * 1024 * 1024
MAX_ENTRIES = 1_000_000
MAX_DEFINITION_BYTES = 4 * 1024 * 1024
MAX_LOADED_DEFINITION_BYTES = 16 * 1024 * 1024
MAX_INDEX_BYTES = 2 * 1024 * 1024 * 1024
MAX_QUERY_RECORDS = 20_000
BANK_NAME = re.compile(r"term_bank_(\d+)\.json\Z")
NodeTag = Literal["div", "p", "span", "ul", "ol", "li", "br", "ruby", "rt"]
NodeRole = Literal["head", "def1", "def2", "dfcn", "exam", "exjp", "excn"]
NODE_TAGS = {"div", "p", "span", "ul", "ol", "li", "br", "ruby", "rt"}
NODE_ROLES = {"head", "def1", "def2", "dfcn", "exam", "exjp", "excn"}


def _search_key(value: str) -> str:
    return "".join(
        chr(ord(character) - 0x60) if "ァ" <= character <= "ヶ" else character
        for character in unicodedata.normalize("NFKC", value)
    )


def _invalid(detail: str = "词典 ZIP 无效，请使用 Yomitan format 3 词典") -> HTTPException:
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
    value: object, depth: int = 0, context: StyleContext | None = None
) -> list[DictionaryNode]:
    context = context or StyleContext()
    if depth > 40:
        raise _invalid("词典正文层次超过限制")
    if isinstance(value, str):
        return [DictionaryNode(text=_string(value, 1_000_000))]
    if isinstance(value, list):
        return [
            node for item in cast(list[object], value) for node in _nodes(item, depth + 1, context)
        ]
    item = _object(value)
    if item.get("type") == "structured-content":
        return _nodes(item.get("content", ""), depth + 1, context)
    if item.get("type") == "text":
        return _nodes(item.get("text", ""), depth + 1, context)
    # Unsupported image/audio resources are never fetched or interpreted as HTML.
    if item.get("type") in {"image", "audio"}:
        return []
    tag = item.get("tag", "span")
    if tag in {"script", "style", "iframe", "object", "img"}:
        return []
    safe_tag = cast(NodeTag, tag if isinstance(tag, str) and tag in NODE_TAGS else "span")
    data = item.get("data")
    role_value = _object(cast(object, data)).get("class") if isinstance(data, dict) else None
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
    style, child_context = sanitize_style(item.get("style"), context)
    return [
        DictionaryNode(
            tag=safe_tag,
            lang=lang,
            role=role,
            style=style,
            content=_nodes(item.get("content", ""), depth + 1, child_context),
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

    async def find_terms(self, keys: list[str]) -> list[DictionaryEntry]:
        if self.connection is None or not keys:
            return []
        values = list(dict.fromkeys(_search_key(key) for key in keys))
        if len(values) > 4096:
            raise _invalid("查询候选超过限制")
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
            raise _invalid("查询词条超过限制")
        clauses = " OR ".join("(dictionary_id = ? AND sequence = ?)" for _ in keys)
        parameters = [value for key in keys for value in key]
        async with self.connection.execute(
            f"SELECT * FROM entries WHERE {clauses} ORDER BY id LIMIT ?",
            [*parameters, MAX_QUERY_RECORDS + 1],
        ) as cursor:
            rows = list(await cursor.fetchall())
        if len(rows) > MAX_QUERY_RECORDS:
            raise _invalid("查询结果超过限制")
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
            decoded, size = await asyncio.to_thread(
                _decode_definitions, rows, MAX_LOADED_DEFINITION_BYTES - self._definition_bytes
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
) -> tuple[dict[str, tuple[DictionaryNode, ...]], int]:
    decoded: dict[str, tuple[DictionaryNode, ...]] = {}
    size = 0
    for identity, payload in rows:
        decoder = zlib.decompressobj()
        try:
            raw = decoder.decompress(payload, min(MAX_DEFINITION_BYTES, budget - size) + 1)
        except zlib.error as exc:
            raise _invalid("词典正文索引无效，请重新导入") from exc
        size += len(raw)
        if len(raw) > MAX_DEFINITION_BYTES or size > budget or not decoder.eof:
            raise _invalid("词典正文索引无效，请重新导入")
        envelope = _object(json.loads(raw))
        # v2 already retains the source. Older sanitized trees can acquire the new
        # safe presentation without a database write or a full dictionary reimport.
        # Fresh trees avoid a second sanitization pass; the snapshot caches both.
        decoded[identity] = (
            tuple(DictionaryNode.model_validate(node) for node in _array(envelope["nodes"]))
            if envelope.get("tree_version") == TREE_VERSION
            else tuple(_nodes(envelope["source"]))
        )
    return decoded, size


class DictionaryStore:
    """Immutable indexes with one transactional library and active selection.

    The original single index remains in place and is exposed without reimport.
    Catalog commits only reference complete files. Healthy indexes are never replaced
    or removed, so an open lookup retains the exact dictionary it started with.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self.library_path = path.with_name(path.name + ".library")
        self.catalog_path = self.library_path / "catalog.sqlite3"
        self._import_lock = asyncio.Lock()

    @asynccontextmanager
    async def _file_snapshot(self, path: Path) -> AsyncGenerator[DictionarySnapshot]:
        try:
            resolved = await asyncio.to_thread(path.resolve)
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

    async def _catalog(self) -> tuple[DictionaryLibrary, dict[str, Path]]:
        try:
            connection = await aiosqlite.connect(
                self.catalog_path.resolve().as_uri() + "?mode=ro", uri=True
            )
        except aiosqlite.OperationalError:
            return await self._legacy_library()
        try:
            # Both reads observe the same committed catalog generation.
            await connection.execute("BEGIN")
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
        except aiosqlite.OperationalError as exc:
            # A concurrent first writer has created the catalog file but has not
            # committed its schema yet, or its first transaction rolled back.
            if "no such table" not in str(exc):
                raise
            return await self._legacy_library()
        finally:
            await connection.close()

    async def library(self) -> DictionaryLibrary:
        library, _ = await self._catalog()
        return library

    @asynccontextmanager
    async def snapshot(self) -> AsyncGenerator[DictionarySnapshot]:
        library, paths = await self._catalog()
        path = paths.get(library.active_dictionary_id) if library.active_dictionary_id else None
        if path is None:
            yield DictionarySnapshot(None)
        else:
            async with self._file_snapshot(path) as snapshot:
                status = await snapshot.status()
                yield (
                    snapshot
                    if status.dictionary_id == library.active_dictionary_id
                    else DictionarySnapshot(None)
                )

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
        replace_index: bool = False,
    ) -> tuple[DictionaryLibrary, bool]:
        self.library_path.mkdir(parents=True, exist_ok=True)
        legacy = await self._legacy_status()
        async with aiosqlite.connect(self.catalog_path) as connection:
            await connection.execute("PRAGMA busy_timeout = 30000")
            await connection.execute("BEGIN IMMEDIATE")
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
            if count == 0 and legacy.ready and legacy.dictionary_id:
                await connection.execute(
                    "INSERT INTO dictionaries VALUES (?, ?, ?, ?, 'legacy')",
                    (legacy.dictionary_id, legacy.title, legacy.revision, legacy.entry_count),
                )
                await connection.execute(
                    "INSERT INTO active VALUES (1, ?)", (legacy.dictionary_id,)
                )
                count = 1
            already_installed = False
            if installed is not None and installed.dictionary_id:
                async with connection.execute(
                    "SELECT 1 FROM dictionaries WHERE dictionary_id = ?", (installed.dictionary_id,)
                ) as cursor:
                    already_installed = await cursor.fetchone() is not None
                await connection.execute(
                    "INSERT OR IGNORE INTO dictionaries VALUES (?, ?, ?, ?, ?)",
                    (
                        installed.dictionary_id,
                        installed.title,
                        installed.revision,
                        installed.entry_count,
                        installed.dictionary_id + ".sqlite3",
                    ),
                )
                if replace_index:
                    await connection.execute(
                        "UPDATE dictionaries SET filename = ? WHERE dictionary_id = ?",
                        (installed.dictionary_id + ".sqlite3", installed.dictionary_id),
                    )
                if count == 0:
                    active_id = installed.dictionary_id
            if active_id is not None:
                async with connection.execute(
                    "SELECT 1 FROM dictionaries WHERE dictionary_id = ?", (active_id,)
                ) as cursor:
                    found = await cursor.fetchone()
                if not found:
                    raise _invalid("所选词典尚未安装，请重新选择")
                await connection.execute(
                    "INSERT OR REPLACE INTO active VALUES (1, ?)", (active_id,)
                )
            await connection.commit()
        return await self.library(), already_installed

    async def select(self, dictionary_id: str) -> DictionaryLibrary:
        _, paths = await self._catalog()
        path = paths.get(dictionary_id)
        if path is None:
            raise _invalid("所选词典尚未安装，请重新选择")
        async with self._file_snapshot(path) as snapshot:
            status = await snapshot.status()
        if not status.ready or status.dictionary_id != dictionary_id:
            raise _invalid("所选词典索引不可用，请重新导入该词典")
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
                                status_code=413, detail="词典 ZIP 超过 256 MiB 限制"
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
        result = (
            DictionaryStatus(**existing.model_dump(), ready=True)
            if existing and valid
            else await asyncio.to_thread(self._build_and_publish, source)
        )
        library, already_installed = await self._write_catalog(
            installed=result,
            active_id=result.dictionary_id if activate else None,
            replace_index=not valid,
        )
        return DictionaryLibraryImport(
            library=library, dictionary_id=identity, already_installed=already_installed
        )

    def _build_and_publish(self, source: Path) -> DictionaryStatus:
        self.library_path.mkdir(parents=True, exist_ok=True)
        fd, raw_path = tempfile.mkstemp(
            prefix=".dictionary-index-", suffix=".sqlite3", dir=self.library_path
        )
        os.close(fd)
        target = Path(raw_path)
        try:
            result = _build(source, target)
            with target.open("rb") as completed:
                os.fsync(completed.fileno())
            published = self.library_path / (str(result.dictionary_id) + ".sqlite3")
            try:
                # A concurrent identical import cannot replace an open snapshot.
                os.link(target, published)
            except FileExistsError:
                # Repair a missing/invalid derived index on explicit same-ZIP import.
                # Healthy immutable indexes (including unregistered crash orphans)
                # stay in place, even when another process publishes the same ZIP.
                healthy = False
                try:
                    with closing(sqlite3.connect(published)) as existing:
                        metadata = existing.execute(
                            "SELECT dictionary_id, version FROM metadata"
                        ).fetchone()
                        healthy = metadata == (result.dictionary_id, INDEX_VERSION)
                except sqlite3.DatabaseError:
                    pass
                if not healthy:
                    os.replace(target, published)
            directory_fd = os.open(self.library_path, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
            return result
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
            raise _invalid() from exc
        finally:
            target.unlink(missing_ok=True)


def _build(source: Path, target: Path) -> DictionaryStatus:
    with source.open("rb") as uploaded:
        digest = hashlib.file_digest(uploaded, "sha256").hexdigest()
    with zipfile.ZipFile(source) as archive, closing(sqlite3.connect(target)) as connection:
        files = archive.infolist()
        if len(files) > 4096 or len({item.filename for item in files}) != len(files):
            raise _invalid()
        if sum(item.file_size for item in files) > MAX_UNPACKED_BYTES:
            raise _invalid("词典解压大小超过限制")
        for item in files:
            if item.flag_bits & 1 or item.file_size > MAX_BANK_BYTES:
                raise _invalid("词典文件大小或加密格式不受支持")
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
            raise _invalid("词典没有 term_bank 文件")
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
                    raise _invalid("单条词典正文超过限制")
                definition_id = hashlib.sha256(source_definitions).hexdigest()
                if definition_id not in seen_definitions:
                    definitions = _nodes(record[5])
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
                        raise _invalid("单条词典正文索引超过限制")
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
            raise _invalid("词典没有可导入条目")
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
        raise _invalid("词典索引大小超过限制")
