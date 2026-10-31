"""Bounded, rebuildable dictionary index, atomically replaced after complete validation.

This private derived SQLite file lives beside the configured application database.
Readers retain one read-only connection while imports publish a new file, so a lookup
never combines records from two dictionary versions. No learning tables are touched.
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

from app.dictionary_schemas import DictionaryNode, DictionaryStatus
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
    def __init__(self, path: Path) -> None:
        self.path = path
        self._import_lock = asyncio.Lock()

    @asynccontextmanager
    async def snapshot(self) -> AsyncGenerator[DictionarySnapshot]:
        try:
            connection = await aiosqlite.connect(
                self.path.resolve().as_uri() + "?mode=ro", uri=True
            )
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

    async def status(self) -> DictionaryStatus:
        try:
            async with self.snapshot() as snapshot:
                return await snapshot.status()
        except aiosqlite.DatabaseError:
            return DictionaryStatus()

    async def find_terms(self, keys: list[str]) -> list[DictionaryEntry]:
        async with self.snapshot() as snapshot:
            return await snapshot.load_definitions(await snapshot.find_terms(keys))

    async def get_sequences(self, keys: list[tuple[str, int]]) -> list[DictionaryEntry]:
        async with self.snapshot() as snapshot:
            return await snapshot.load_definitions(await snapshot.get_sequences(keys))

    async def import_stream(self, chunks: AsyncIterator[bytes]) -> DictionaryStatus:
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
                task = asyncio.create_task(asyncio.to_thread(self._build_and_publish, source))
                try:
                    return await asyncio.shield(task)
                except asyncio.CancelledError:
                    # The worker owns its source until it finishes; cancellation cannot
                    # unlink it midway or release the publisher lock prematurely.
                    await task
                    raise
            finally:
                await asyncio.to_thread(source.unlink, missing_ok=True)

    def _build_and_publish(self, source: Path) -> DictionaryStatus:
        fd, raw_path = tempfile.mkstemp(
            prefix=".dictionary-index-", suffix=".sqlite3", dir=self.path.parent
        )
        os.close(fd)
        target = Path(raw_path)
        try:
            result = _build(source, target)
            with target.open("rb") as completed:
                os.fsync(completed.fileno())
            os.replace(target, self.path)
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
