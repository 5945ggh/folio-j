"""Bounded, source-aligned dictionary recall and stable sequence card ranking."""

from __future__ import annotations

import asyncio
import threading
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from typing import TYPE_CHECKING, cast

from fastapi import HTTPException
from sudachipy import dictionary

from app.dictionary_schemas import (
    DictionaryLookupRequest,
    DictionaryLookupResponse,
    DictionaryMatch,
    DictionaryNode,
    DictionaryTokenHint,
)
from app.nlp.contracts import MaterialReadingToken
from app.nlp.tokenization import Analyzer, tokenize_chunk

if TYPE_CHECKING:
    from app.services.dictionary_store import DictionaryEntry, DictionaryStore

# All limits count original Unicode codepoints. Literal recall has at most 528 spans.
MAX_WORD_LENGTH = 32
TOKEN_CONTEXT = 96
MAX_CARDS = 40
MAX_TOKEN_COMPOUND = 8
_BREAKS = frozenset('。！？!?、，,；;：:「」『』【】（）()[]{}"“”')
_ANALYZER_LOCK = threading.Lock()
_lexicon: dictionary.Dictionary | None = None


@dataclass(frozen=True)
class _Candidate:
    key: str
    start: int
    end: int
    reading: str = ""
    lemma: str = ""
    pos: tuple[str, ...] = ()
    term_only: bool = False


def _key(value: str) -> str:
    """Comparison only: never use normalized lengths as source coordinates."""
    value = unicodedata.normalize("NFKC", value)
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in value)


def _word_text(value: str) -> bool:
    return bool(value) and not any(c.isspace() or c in _BREAKS for c in value)


@lru_cache(maxsize=128)
def _analyze(text: str) -> tuple[MaterialReadingToken, ...]:
    # Sudachi objects are reused under one lock; CPU/native work runs off the event loop.
    global _lexicon
    with _ANALYZER_LOCK:
        if _lexicon is None:
            _lexicon = dictionary.Dictionary(dict="core")
        return tuple(tokenize_chunk(cast(Analyzer, _lexicon.create()), text, 0))


def _hints(request: DictionaryLookupRequest) -> list[DictionaryTokenHint]:
    text = request.text
    point = request.position if request.position is not None else request.selection_start
    assert point is not None
    hints = [
        hint
        for hint in request.tokens
        if 0 <= hint.start < hint.end <= len(text)
        and text[hint.start : hint.end] == hint.surface
        and _word_text(hint.surface)
        and point - TOKEN_CONTEXT <= hint.start <= point + TOKEN_CONTEXT
        and hint.end - hint.start <= MAX_WORD_LENGTH
    ]
    aligned: list[DictionaryTokenHint] = []
    for hint in sorted(hints, key=lambda t: (t.start, t.end)):
        if not aligned or hint.start >= aligned[-1].end:
            aligned.append(hint)
    return aligned


def _complete_tokens(request: DictionaryLookupRequest) -> list[MaterialReadingToken] | None:
    """Reuse complete aligned analysis only when no affecting token can be missing."""
    point = request.position if request.position is not None else request.selection_start
    assert point is not None
    first = max(0, point - MAX_WORD_LENGTH + 1)
    last = min(len(request.text), point + MAX_WORD_LENGTH)
    hints = sorted(
        (hint for hint in request.tokens if hint.end > first and hint.start < last),
        key=lambda hint: (hint.start, hint.end),
    )
    result: list[MaterialReadingToken] = []
    cursor = first
    for hint in hints:
        if (
            not 0 <= hint.start < hint.end <= len(request.text)
            or request.text[hint.start : hint.end] != hint.surface
            or not hint.reading
            or not hint.dictionary_form
            or not hint.normalized_form
            or len(hint.pos) != 6
            or (result and hint.start < result[-1].end)
            or request.text[cursor : hint.start].strip()
        ):
            return None
        # A token may cross the recall window edge, but it must be present whole.
        # A frontend-clipped first/last token fails surface/coverage validation.
        result.append(MaterialReadingToken(**hint.model_dump()))
        cursor = hint.end
    if not result or cursor < last and request.text[cursor:last].strip():
        return None
    return result


def _tokens(request: DictionaryLookupRequest) -> list[MaterialReadingToken]:
    complete = _complete_tokens(request)
    if complete is not None:
        return complete
    point = request.position if request.position is not None else request.selection_start
    assert point is not None
    start = max(0, point - TOKEN_CONTEXT)
    end = min(len(request.text), point + TOKEN_CONTEXT)
    hints = {(h.start, h.end): h for h in _hints(request)}
    result: list[MaterialReadingToken] = []
    for original in _analyze(request.text[start:end]):
        if original.start == original.end:
            continue
        local = original.model_copy(
            update={"start": original.start + start, "end": original.end + start}
        )
        hint = hints.get((local.start, local.end))
        if hint is not None:
            local = local.model_copy(
                update={
                    "reading": hint.reading or local.reading,
                    "dictionary_form": hint.dictionary_form or local.dictionary_form,
                    "normalized_form": hint.normalized_form or local.normalized_form,
                    "pos": hint.pos if len(hint.pos) == 6 else local.pos,
                }
            )
        result.append(local)
    return result


def _covers(request: DictionaryLookupRequest, start: int, end: int) -> bool:
    if request.selection_start is not None:
        return (start, end) == (request.selection_start, request.selection_end)
    assert request.position is not None
    return start <= request.position < end


def _candidates(request: DictionaryLookupRequest) -> list[_Candidate]:
    text = request.text
    candidates: set[_Candidate] = set()

    def add(candidate: _Candidate) -> None:
        if candidate.key and _covers(request, candidate.start, candidate.end):
            candidates.add(candidate)

    if request.selection_start is not None:
        assert request.selection_end is not None
        add(
            _Candidate(
                text[request.selection_start : request.selection_end],
                request.selection_start,
                request.selection_end,
            )
        )
    else:
        assert request.position is not None
        point = request.position
        for start in range(max(0, point - MAX_WORD_LENGTH + 1), point + 1):
            for end in range(point + 1, min(len(text), start + MAX_WORD_LENGTH) + 1):
                surface = text[start:end]
                if _word_text(surface):
                    add(_Candidate(surface, start, end))

    # Boundary hints remain useful even when their granularity differs from the
    # local tokenizer. Partial fields supply evidence without suppressing fallback.
    for hint in _hints(request):
        for form in (hint.surface, hint.dictionary_form, hint.normalized_form):
            if form:
                add(
                    _Candidate(
                        form,
                        hint.start,
                        hint.end,
                        hint.reading,
                        hint.dictionary_form or hint.surface,
                        tuple(hint.pos) if len(hint.pos) == 6 else (),
                        form != hint.surface,
                    )
                )

    tokens = _tokens(request)
    for index, token in enumerate(tokens):
        if not _word_text(token.surface):
            continue
        # Token-boundary compounds complement literal character spans. The last lexical
        # token supplies its lemma; auxiliary suffixes retain their actual source extent.
        ends = [token.end]
        previous = token.end
        for following in tokens[index + 1 : index + MAX_TOKEN_COMPOUND]:
            auxiliary = (
                following.pos[0] == "助動詞"
                or (
                    following.pos[:2] == ["助詞", "接続助詞"]
                    and following.surface in {"て", "で"}
                    and token.pos[0] in {"動詞", "形容詞"}
                )
                or (
                    token.pos[0] == "形容詞"
                    and following.pos[:2] == ["形容詞", "非自立可能"]
                    and following.dictionary_form == "ない"
                )
                or (
                    following.pos[:2] == ["動詞", "非自立可能"]
                    and text[previous - 1 : previous] in {"て", "で"}
                    and following.dictionary_form
                    in {"いる", "おる", "ある", "しまう", "みる", "いく", "くる"}
                )
            )
            if following.start != previous or not auxiliary:
                break
            ends.append(following.end)
            previous = following.end
        for first in tokens[max(0, index - MAX_TOKEN_COMPOUND + 1) : index + 1]:
            start = first.start
            if not _word_text(text[start : token.end]):
                continue
            if token.end - start > MAX_WORD_LENGTH:
                continue
            prefix = text[start : token.start]
            for end in ends:
                if end - start > MAX_WORD_LENGTH:
                    break
                restored = end != token.end
                for form in (
                    token.surface if not restored else "",
                    token.dictionary_form,
                    token.normalized_form,
                ):
                    if not form:
                        continue
                    add(
                        _Candidate(
                            prefix + form,
                            start,
                            end,
                            token.reading
                            if not prefix and not restored and form == token.surface
                            else "",
                            prefix + token.dictionary_form,
                            tuple(token.pos),
                            restored or form != token.surface,
                        )
                    )
    return sorted(
        candidates,
        key=lambda c: (c.start, c.end, c.key, c.reading, c.lemma, c.pos, c.term_only),
    )


def _pos_score(entry: DictionaryEntry, candidate: _Candidate) -> int:
    if len(candidate.pos) != 6 or not entry.rules:
        return 0
    rules = set(entry.rules.split())
    if candidate.pos[0] == "動詞":
        conjugation = candidate.pos[4]
        if "一段" in conjugation:
            return int("v1" in rules)
        if "五段" in conjugation:
            return int("v5" in rules)
        if "サ行変格" in conjugation:
            return int(bool(rules & {"vs", "vs-s", "vs-i"}))
        if "カ行変格" in conjugation:
            return int("vk" in rules)
    if candidate.pos[0] == "形容詞":
        return int("adj-i" in rules)
    return 0


def _rank(entry: DictionaryEntry, candidate: _Candidate) -> tuple[int, int, int, int, int]:
    reading = bool(
        candidate.reading and _key(entry.reading or entry.term) == _key(candidate.reading)
    )
    lemma = bool(candidate.lemma and _key(entry.term) == _key(candidate.lemma))
    return (
        -(candidate.end - candidate.start),
        -int(lemma),
        -int(reading),
        -_pos_score(entry, candidate),
        entry.order,
    )


def _group(entry: DictionaryEntry) -> tuple[str, str, int]:
    if entry.sequence is not None and entry.sequence >= 0:
        return (entry.dictionary_id, "sequence", entry.sequence)
    return (entry.dictionary_id, "entry", entry.id)


def _best_matches(
    entries: list[DictionaryEntry], candidates: list[_Candidate]
) -> list[tuple[DictionaryEntry, _Candidate]]:
    by_key: dict[str, list[_Candidate]] = {}
    for candidate in candidates:
        by_key.setdefault(_key(candidate.key), []).append(candidate)
    best: dict[tuple[str, str, int], tuple[DictionaryEntry, _Candidate]] = {}
    for entry in entries:
        # A restored lemma proves an original range only for that spelling.
        # Matching an inflected stem's reading cannot transfer its auxiliaries
        # onto an unrelated homophone (見ました -> 身 / み).
        options = by_key.get(_key(entry.term), []) + [
            candidate
            for candidate in by_key.get(_key(entry.reading), [])
            if not candidate.term_only
        ]
        if not options:
            continue
        candidate = min(options, key=lambda c: _rank(entry, c))
        group = _group(entry)
        old = best.get(group)
        if old is None or _rank(entry, candidate) < _rank(*old):
            best[group] = (entry, candidate)
    return sorted(best.values(), key=lambda pair: _rank(*pair))[:MAX_CARDS]


def _assemble(
    entries: list[DictionaryEntry],
    ordered: list[tuple[DictionaryEntry, _Candidate]],
    request: DictionaryLookupRequest,
) -> DictionaryLookupResponse:
    groups: dict[tuple[str, str, int], list[DictionaryEntry]] = {}
    seen_entries: set[tuple[str, int]] = set()
    for entry in entries:
        if (entry.dictionary_id, entry.id) in seen_entries:
            continue
        seen_entries.add((entry.dictionary_id, entry.id))
        group_entries = groups.setdefault(_group(entry), [])
        group_entries.append(entry)
    matches: list[DictionaryMatch] = []
    for entry, candidate in ordered:
        definitions: list[DictionaryNode] = []
        seen: set[str] = set()
        for sibling in sorted(groups[_group(entry)], key=lambda e: e.order):
            for node in sibling.definitions:
                identity = node.model_dump_json()
                if identity not in seen:
                    definitions.append(node)
                    seen.add(identity)
        group = _group(entry)
        matches.append(
            DictionaryMatch(
                id=f"{entry.dictionary_id}:{group[1]}:{group[2]}",
                dictionary_id=entry.dictionary_id,
                term=entry.term,
                reading=entry.reading,
                start=candidate.start,
                end=candidate.end,
                surface=request.text[candidate.start : candidate.end],
                definitions=definitions,
            )
        )
    return DictionaryLookupResponse(matches=matches)


async def lookup(
    store: DictionaryStore, request: DictionaryLookupRequest
) -> DictionaryLookupResponse:
    """Recall covering source spans, rank actual hits, then expand complete sequence cards."""
    async with store.snapshot() as snapshot:
        if request.expected_dictionary_id is not None:
            status = await snapshot.status()
            if not status.ready or status.dictionary_id != request.expected_dictionary_id:
                raise HTTPException(status_code=409, detail="当前词典已改变，请重新查词")
        candidates = await asyncio.to_thread(_candidates, request)
        keys = sorted({c.key for c in candidates})
        entries = await snapshot.find_terms(keys)
        ordered = await asyncio.to_thread(_best_matches, entries, candidates)
        sequences = [
            (entry.dictionary_id, entry.sequence)
            for entry, _ in ordered
            if entry.sequence is not None and entry.sequence >= 0
        ]
        siblings = await snapshot.get_sequences(sequences) if sequences else []
        selected_groups = {_group(entry) for entry, _ in ordered}
        selected = [entry for entry in entries if _group(entry) in selected_groups] + siblings
        loaded = await snapshot.load_definitions(selected)
    return await asyncio.to_thread(_assemble, loaded, ordered, request)
