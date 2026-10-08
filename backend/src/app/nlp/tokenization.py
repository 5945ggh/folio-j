"""Sudachi A tokens preserve original resource codepoints, including rewritten input."""

import hashlib
import json
import re
import zlib
from dataclasses import dataclass
from importlib.metadata import version
from typing import Protocol, cast

from sudachipy import dictionary, errors, tokenizer

from app.epub_schemas import CompiledBook
from app.readings_schemas import MaterialReadingToken, MaterialResourceReadings

# SudachiPy 0.6.11: original input limit 49149 UTF-8 bytes, rewritten input 65535.
# Smaller chunks leave headroom for input plugins; only length errors are retried.
MAX_CHUNK_BYTES = 12000
FORMAT_VERSION = "resource-readings-v1"
SPLIT_VERSION = "sentence-utf8-v1"


class Token(Protocol):
    def begin(self) -> int: ...
    def end(self) -> int: ...
    def surface(self) -> str: ...
    def reading_form(self) -> str: ...
    def dictionary_form(self) -> str: ...
    def normalized_form(self) -> str: ...
    def part_of_speech(self) -> tuple[str, ...]: ...
    def is_oov(self) -> bool: ...


class Analyzer(Protocol):
    def tokenize(self, text: str, mode: object) -> list[Token]: ...


@dataclass(frozen=True)
class GeneratedReadings:
    configuration: str
    asset_sha256: str
    token_count: int
    payload: bytes


def chunks(text: str, budget: int = MAX_CHUNK_BYTES) -> list[tuple[int, str]]:
    """Sentence-first split with strict UTF-8 limits and exact reconstruction."""
    result: list[tuple[int, str]] = []
    offset = 0
    for sentence in re.findall(r"[^。！？\n]*[。！？\n]|[^。！？\n]+$", text):
        start = 0
        size = 0
        for index, character in enumerate(sentence):
            length = len(character.encode("utf-8"))
            if size + length > budget and index > start:
                result.append((offset + start, sentence[start:index]))
                start, size = index, 0
            size += length
        if start < len(sentence):
            result.append((offset + start, sentence[start:]))
        offset += len(sentence)
    if "".join(value for _, value in result) != text:
        raise ValueError("分句未完整保留原文")
    return result


def tokenize_chunk(analyzer: Analyzer, text: str, offset: int) -> list[MaterialReadingToken]:
    try:
        tokens = analyzer.tokenize(text, tokenizer.Tokenizer.SplitMode.A)
    except (ValueError, RuntimeError, errors.SudachiError) as exc:
        message = str(exc).lower()
        if len(text) > 1 and any(
            marker in message for marker in ("too long", "input length", "input is too")
        ):
            middle = len(text) // 2
            return tokenize_chunk(analyzer, text[:middle], offset) + tokenize_chunk(
                analyzer, text[middle:], offset + middle
            )
        raise
    result: list[MaterialReadingToken] = []
    previous = 0
    for token in tokens:
        start, end = token.begin(), token.end()
        surface = token.surface()
        if not 0 <= start <= end <= len(text) or start < previous or text[start:end] != surface:
            raise ValueError("分词位置与原文不一致")
        if text[previous:start].strip():
            raise ValueError("分词遗漏原文")
        pos = list(token.part_of_speech())
        if len(pos) != 6:
            raise ValueError("词性字段不是六项")
        result.append(
            MaterialReadingToken(
                start=offset + start,
                end=offset + end,
                surface=surface,
                reading=token.reading_form(),
                dictionary_form=token.dictionary_form(),
                normalized_form=token.normalized_form(),
                pos=pos,
                is_oov=token.is_oov(),
            )
        )
        previous = end
    if text[previous:].strip():
        raise ValueError("分词遗漏原文结尾")
    return result


def generate(book: CompiledBook) -> GeneratedReadings:
    """One tokenizer per complete generation, reused across every resource/chunk."""
    configuration = json.dumps(
        {
            "analyzer": "SudachiPy",
            "analyzer_version": version("SudachiPy"),
            "dictionary": "core",
            "dictionary_version": version("SudachiDict-core"),
            "mode": "A",
            "format": FORMAT_VERSION,
            "split": SPLIT_VERSION,
            "max_chunk_bytes": MAX_CHUNK_BYTES,
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    resources: list[MaterialResourceReadings] = []
    lexicon = dictionary.Dictionary(dict="core")
    try:
        analyzer = cast(Analyzer, lexicon.create())
        for resource in book.resources:
            digest = hashlib.sha256(resource.text.encode()).hexdigest()
            if digest != resource.text_sha256:
                raise ValueError("材料正文摘要不一致")
            tokens: list[MaterialReadingToken] = []
            for offset, text in chunks(resource.text):
                tokens.extend(tokenize_chunk(analyzer, text, offset))
            resources.append(
                MaterialResourceReadings(
                    resource_id=resource.id,
                    text_sha256=digest,
                    tokens=tokens,
                )
            )
    finally:
        lexicon.close()
    raw = json.dumps(
        {"configuration": configuration, "resources": [r.model_dump() for r in resources]},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return GeneratedReadings(
        configuration=configuration,
        asset_sha256=hashlib.sha256(raw).hexdigest(),
        token_count=sum(len(r.tokens) for r in resources),
        payload=zlib.compress(raw),
    )
