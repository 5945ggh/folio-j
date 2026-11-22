from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import cast

from app.dictionary_schemas import DictionaryLookupRequest, DictionaryNode, DictionaryTokenHint
from app.services.dictionary_lookup import (
    _key,  # pyright: ignore[reportPrivateUsage]
    lookup,
)
from app.services.dictionary_store import DictionaryEntry, DictionaryStore


def entry(
    term: str,
    *,
    id: int = 1,
    reading: str = "",
    sequence: int | None = None,
    definition: str = "释义",
    rules: str = "",
    dictionary_id: str = "test-v1",
) -> DictionaryEntry:
    return DictionaryEntry(
        id=id,
        dictionary_id=dictionary_id,
        term=term,
        reading=reading,
        rules=rules,
        sequence=sequence,
        definitions=(DictionaryNode(text=definition),),
        order=id,
        definition_tags="",
        term_tags="",
        score=0,
    )


def token(
    text: str,
    start: int,
    end: int,
    *,
    lemma: str | None = None,
    reading: str = "",
    pos: list[str] | None = None,
) -> DictionaryTokenHint:
    return DictionaryTokenHint(
        start=start,
        end=end,
        surface=text[start:end],
        reading=reading,
        dictionary_form=lemma or text[start:end],
        normalized_form=lemma or text[start:end],
        pos=pos or ["名詞", "普通名詞", "一般", "*", "*", "*"],
        is_oov=False,
    )


class MemoryStore:
    def __init__(self, entries: list[DictionaryEntry]) -> None:
        self.entries = entries
        self.find_calls = 0
        self.sequence_calls = 0
        self.query_keys: list[str] = []

    @asynccontextmanager
    async def snapshot(self) -> AsyncGenerator["MemoryStore"]:
        yield self

    async def find_terms(self, keys: list[str]) -> list[DictionaryEntry]:
        self.find_calls += 1
        self.query_keys = keys
        normalized = {_key(k) for k in keys}
        return [e for e in self.entries if {_key(e.term), _key(e.reading)} & normalized]

    async def load_definitions(self, entries: list[DictionaryEntry]) -> list[DictionaryEntry]:
        return entries

    async def get_sequences(self, keys: list[tuple[str, int]]) -> list[DictionaryEntry]:
        self.sequence_calls += 1
        return [e for e in self.entries if (e.dictionary_id, e.sequence) in keys]


async def query(store: MemoryStore, request: DictionaryLookupRequest) -> list[tuple[str, int, int]]:
    result = await lookup(cast(DictionaryStore, store), request)
    assert all(request.text[m.start : m.end] == m.surface for m in result.matches)
    return [(m.term, m.start, m.end) for m in result.matches]
