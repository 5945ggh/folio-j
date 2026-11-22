"""Measure dictionary lookup granularity offline with synthetic input and entries.

Run from the repository root with backend/.venv/bin/python and
scripts/benchmark_dictionary_granularity.py --output /tmp/dictionary-granularity.json.

Timing excludes dictionary opening, fixture/request construction, and HTTP.
Cache misses keep the dictionary open. Allocation measurements use tracemalloc
in separate runs, covering Python allocations only. The isolated lookup module
comes from the pinned baseline commit so production changes do not change the
candidate or ranking algorithm behind this comparison.
"""

from __future__ import annotations

import argparse
import asyncio
import gc
import json
import math
import platform
import random
import statistics
import subprocess
import sys
import time
import tracemalloc
from collections.abc import AsyncGenerator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from functools import lru_cache
from importlib.metadata import version
from pathlib import Path
from types import ModuleType
from typing import Literal, Protocol, cast

from sudachipy import Dictionary, SplitMode

from app.dictionary_schemas import (
    DictionaryLookupRequest,
    DictionaryLookupResponse,
    DictionaryNode,
    DictionaryTokenHint,
)
from app.nlp.contracts import MaterialReadingToken
from app.nlp.tokenization import Token, tokenize_chunk
from app.services.dictionary_store import DictionaryEntry, DictionaryStore

BASELINE_REF = "653a4d60adf6753bf091e709a4a3c6f3bffb658d"
ROOT = Path(__file__).resolve().parents[1]
Strategy = Literal["A", "C", "C+B/A", "3 tokenize"]
TokenChain = tuple[MaterialReadingToken, ...]
STRATEGIES: tuple[Strategy, ...] = ("A", "C", "C+B/A")
STAGES = ("analysis", "candidates", "lookup")
CONTEXT = 96  # Original codepoints on each side of the click.
CACHE_SIZE = 128


class Candidate(Protocol):
    key: str
    start: int
    end: int


class LookupModule(Protocol):
    complete_tokens: Callable[[DictionaryLookupRequest], list[MaterialReadingToken] | None]
    hints: Callable[[DictionaryLookupRequest], list[DictionaryTokenHint]]
    candidates: Callable[[DictionaryLookupRequest], list[Candidate]]
    key: Callable[[str], str]

    async def lookup(
        self, store: DictionaryStore, request: DictionaryLookupRequest
    ) -> DictionaryLookupResponse: ...


@dataclass
class Calls:
    tokenize: int = 0
    split: int = 0


@dataclass(frozen=True)
class Pretokenized:
    morphemes: list[Token]

    def tokenize(self, text: str, mode: object) -> list[Token]:
        return self.morphemes


def analyze(
    lexicon: Dictionary,
    strategy: Strategy,
    text: str,
    calls: Calls,
    *,
    reuse_a: bool = False,
) -> tuple[TokenChain, ...]:
    tokenizer = lexicon.create()

    def tokenize(mode: SplitMode) -> TokenChain:
        calls.tokenize += 1
        return tuple(tokenize_chunk(Pretokenized(list(tokenizer.tokenize(text, mode))), text, 0))

    if strategy == "A":
        return (tokenize(SplitMode.A),)
    if strategy == "C":
        return (tokenize(SplitMode.C),)
    if strategy == "3 tokenize":
        return tuple(tokenize(mode) for mode in (SplitMode.C, SplitMode.B, SplitMode.A))

    calls.tokenize += 1
    original = list(tokenizer.tokenize(text, SplitMode.C))
    parents = tuple(tokenize_chunk(Pretokenized([part for part in original]), text, 0))

    def children(mode: SplitMode) -> TokenChain:
        result: list[MaterialReadingToken] = []
        for morpheme, parent in zip(original, parents, strict=True):
            if not parent.is_oov:
                calls.split += 1
                parts = list(morpheme.split(mode))
                if parts:
                    span = text[parent.start : parent.end]
                    # The production validator expects offsets within the
                    # original window. Split pieces use those offsets too.
                    validated = tokenize_chunk(
                        Pretokenized([part for part in parts]),
                        " " * parent.start + span,
                        0,
                    )
                    result.extend(validated)
                    continue
            result.append(parent)
        return tuple(result)

    middle = children(SplitMode.B)
    if reuse_a:
        return (parents, middle)
    return (parents, middle, children(SplitMode.A))


def bounded_text(request: DictionaryLookupRequest) -> tuple[int, str]:
    point = request.position if request.position is not None else request.selection_start
    assert point is not None
    start = max(0, point - CONTEXT)
    return start, request.text[start : point + CONTEXT]


def source(
    strategy: Strategy,
    analysis: Callable[[str], tuple[TokenChain, ...]],
    normalization: Callable[[str], TokenChain],
    *,
    full_hints: bool,
) -> LookupModule:
    filename = "backend/src/app/services/dictionary_lookup.py"
    revision_source = subprocess.check_output(
        ["git", "show", f"{BASELINE_REF}:{filename}"],
        cwd=ROOT,
        text=True,
        encoding="utf-8",
    )
    if strategy != "A":
        # Run literal/hint recall once. Each chain gets its own compound and
        # auxiliary search, and original candidate deduplication stays shared.
        head = "    tokens = _tokens(request)\n"
        start = revision_source.index(head, revision_source.index("def _candidates("))
        stop = revision_source.index("    return sorted(\n", start)
        token_recall = revision_source[start + len(head) : stop]
        revision_source = (
            revision_source[:start]
            + "    for tokens in _benchmark_token_chains(request):\n"
            + "".join(
                "    " + line if line.strip() else line
                for line in token_recall.splitlines(keepends=True)
            )
            + revision_source[stop:]
        )

    name = f"_dictionary_benchmark_{strategy}_{full_hints}"
    module = ModuleType(name)
    sys.modules[name] = module
    # Only the fixed local Git revision above supplies executable source.
    pinned_lookup = compile(revision_source, f"{BASELINE_REF}:{filename}", "exec")
    exec(pinned_lookup, module.__dict__)  # noqa: S102
    for function in ("complete_tokens", "hints", "candidates", "key"):
        module.__dict__[function] = module.__dict__[f"_{function}"]
    module.__dict__["_analyze"] = normalization
    service = cast(LookupModule, module)
    if strategy == "A":
        return service

    def chains(request: DictionaryLookupRequest) -> list[list[MaterialReadingToken]]:
        offset, text = bounded_text(request)
        local_chains = analysis(text)
        hints = {(hint.start, hint.end): hint for hint in service.hints(request)}
        complete = service.complete_tokens(request) if full_hints and strategy == "C+B/A" else None
        result: list[list[MaterialReadingToken]] = []
        for local in local_chains:
            aligned: list[MaterialReadingToken] = []
            for token in local:
                if token.start == token.end:
                    continue
                start, end = token.start + offset, token.end + offset
                hint = hints.get((start, end))
                updates: dict[str, object] = {"start": start, "end": end}
                if hint is not None:
                    updates.update(
                        reading=hint.reading or token.reading,
                        dictionary_form=hint.dictionary_form or token.dictionary_form,
                        normalized_form=hint.normalized_form or token.normalized_form,
                        pos=hint.pos if len(hint.pos) == 6 else token.pos,
                    )
                aligned.append(token.model_copy(update=updates) if offset or hint else token)
            if aligned not in result:
                result.append(aligned)
        if full_hints and strategy == "C+B/A":
            assert complete is not None
            if complete not in result:
                result.append(complete)
        return result

    module.__dict__["_benchmark_token_chains"] = chains
    return service


@dataclass(frozen=True)
class Sample:
    name: str
    text: str
    clicked: str
    offset: int = 0


SAMPLES = (
    Sample("three-granularities", "明日、外国人参政権について考えよう。", "外国人", 2),
    Sample("literal-compound", "彼は国際連合大学で学ぶ。", "連合", 1),
    Sample("internal-reading", "人気者が現れた。", "人気"),
    Sample("c-compound-inflection", "情報処理技術者試験に申し込んだ。", "申し込んだ", 4),
    Sample("a-inner-inflection", "情報処理技術者試験に申し込んだ。", "込んだ", 2),
    Sample("alternate-spelling", "想い出しました。", "想い出しました", 5),
    Sample("auxiliary", "この部屋は空いていない。", "空いていない", 5),
    Sample("kana", "よくみました。", "みました", 3),
    Sample("unicode", "𠮷はｶﾀｶﾅを読む。", "ｶﾀｶﾅ", 2),
    Sample("compatibility", "そこに㈱と㍿が書いてある。", "㍿"),
    Sample("proper-noun", "東京都立大学の図書館へ行った。", "東京都立大学", 3),
    Sample("b-compound", "日本語能力試験を受けた。", "日本語", 2),
    Sample("noun", "今日は人工知能の研究を続けている。", "人工知能", 2),
    Sample("suru", "東京大学院で勉強していた。", "勉強していた", 5),
    Sample("contracted", "冷たい麦茶を飲んじゃった。", "飲んじゃった", 5),
    Sample("passive", "国際連合安全保障理事会が開かれた。", "開かれた", 3),
    Sample("short-pos", "子供が見つける。", "見つける", 2),
    Sample("ordinary", "生命保険に入った。", "生命保険", 1),
    Sample("adjective", "今日はあまり高くなかった。", "高くなかった", 4),
    Sample("potential", "今日中に食べられなかった。", "食べられなかった", 7),
    Sample("teiru", "閉まっていた戸を開けた。", "閉まっていた", 5),
    Sample("single", "細長い道を歩いた。", "道"),
    Sample("proper-noun-reading", "日本銀行総裁が挨拶した。", "日本銀行", 2),
    Sample("katakana", "カップラーメンを食べます。", "ラーメン", 3),
    Sample("compound-a", "生物化学を学ぶ。", "生物化学", 1),
    Sample("compound-b", "日本海側から風が吹いた。", "日本海", 1),
    Sample("compound-c", "一段落して重箱読みを調べた。", "重箱読み", 2),
    Sample("compound-d", "日本酒をあたためた。", "日本酒", 2),
    Sample("masu", "国語辞典を買いました。", "買いました", 4),
    Sample("bounding-left", "新聞の見出しを読んだ。" * 20 + "中国語を学んだ。", "中国語", 2),
    Sample(
        "max-context",
        "図書館の資料を見て古い地名を順番に書き写した。"
        "国際連合安全保障理事会の記録も少し調べてノートに残した。"
        "生命保険に入った友人の記事は切り取った。"
        + "国政地方政策審議会専門委員会研究資料報告編集部発行書籍一覧長期保存展示企画"
        + "外国人参政権の議論を聞いてみんなで事務所に戻った。"
        "窓を開けると遠くから聞こえる音がかすかに部屋に入ってきた。" * 3,
        "外国人",
        2,
    ),
    Sample(
        "long-run",
        "外国人参政権国際連合安全保障理事会東京都立大学日本語能力試験" * 9,
        "参政権",
        1,
    ),
)

# Earlier distractors purposely win unassisted same-span ties. The
# alternative readings here are synthetic scoring fixtures, not lexicography.
ENTRIES: tuple[tuple[str, str, str], ...] = (
    ("外国人", "がいこくにん", ""),
    ("外国人", "がいこくじん", ""),
    ("外国人参政権", "がいこくじんさんせいけん", ""),
    ("人", "ひと", ""),
    ("人", "じん", ""),
    ("参政権", "さんせいけん", ""),
    ("国際連合大学", "こくさいれんごうだいがく", ""),
    ("連合", "れんごう", ""),
    ("人気", "ひとけ", ""),
    ("人気", "にんき", ""),
    ("人気者", "にんきもの", ""),
    ("申し込む", "もうしこむ", "v5"),
    ("込む", "こむ", "v5"),
    ("思い出す", "おもいだす", "v5"),
    ("空く", "あく", "v5"),
    ("身", "み", ""),
    ("見る", "みる", "v1"),
    ("カタカナ", "かたかな", ""),
    ("株式会社", "かぶしきがいしゃ", ""),
    ("東京都立大学", "とうきょうとりつだいがく", ""),
    ("図書館", "としょかん", ""),
    ("日本語", "にほんご", ""),
    ("人工知能", "じんこうちのう", ""),
    ("勉強する", "べんきょうする", "vs"),
    ("飲む", "のむ", "v5"),
    ("開く", "ひらく", "v5"),
    ("見つける", "みつける", "v1"),
    ("生命保険", "せいめいほけん", ""),
    ("高い", "たかい", "adj-i"),
    ("食べる", "たべる", "v1"),
    ("閉まる", "しまる", "v5"),
    ("道", "みち", ""),
    ("日本銀行", "にっぽんぎんこう", ""),
    ("ラーメン", "らーめん", ""),
    ("生物", "せいぶつ", ""),
    ("日本海", "にほんかい", ""),
    ("重箱読み", "じゅうばこよみ", ""),
    ("日本酒", "にほんしゅ", ""),
    ("買う", "かう", "v5"),
    ("中国語", "ちゅうごくご", ""),
)


class MemoryStore:
    def __init__(self, normalize: Callable[[str], str]) -> None:
        self.normalize = normalize
        self.terms: dict[str, list[DictionaryEntry]] = {}
        self.sequences: dict[tuple[str, int], list[DictionaryEntry]] = {}
        for order, (term, reading, rules) in enumerate(ENTRIES, start=1):
            entry = DictionaryEntry(
                id=order,
                dictionary_id="synthetic",
                term=term,
                reading=reading,
                rules=rules,
                sequence=order,
                definitions=(DictionaryNode(text=f"合成释义 {order}"),),
                order=order,
                definition_tags="",
                term_tags="",
                score=0,
            )
            for key in {term, reading} - {""}:
                self.terms.setdefault(normalize(key), []).append(entry)
            self.sequences[("synthetic", order)] = [entry]

    @asynccontextmanager
    async def snapshot(self) -> AsyncGenerator[MemoryStore]:
        yield self

    async def find_terms(self, keys: list[str]) -> list[DictionaryEntry]:
        found = {
            entry.id: entry for key in keys for entry in self.terms.get(self.normalize(key), ())
        }
        return [found[identity] for identity in sorted(found)]

    async def get_sequences(self, keys: list[tuple[str, int]]) -> list[DictionaryEntry]:
        return [entry for key in keys for entry in self.sequences[key]]

    async def load_definitions(self, entries: list[DictionaryEntry]) -> list[DictionaryEntry]:
        return entries


def request_for(
    sample: Sample, lexicon: Dictionary, *, full_hints: bool
) -> DictionaryLookupRequest:
    request = DictionaryLookupRequest(
        text=sample.text, position=sample.text.index(sample.clicked) + sample.offset
    )
    if full_hints:
        offset, text = bounded_text(request)
        tokens = analyze(lexicon, "A", text, Calls())[0]
        request.tokens = [
            DictionaryTokenHint.model_validate(
                token.model_dump() | {"start": token.start + offset, "end": token.end + offset}
            )
            for token in tokens
            if token.start < token.end
        ]
    return request


def distribution(values: list[int]) -> dict[str, float | int]:
    ordered = sorted(values)
    return {
        "n": len(values),
        "median": statistics.median(ordered),
        "p95": ordered[math.ceil(len(ordered) * 0.95) - 1],
        "max": ordered[-1],
    }


@dataclass(frozen=True)
class Trial:
    analysis: Callable[[str], tuple[TokenChain, ...]]
    clear_cache: Callable[[], None]
    calls: Calls
    service: LookupModule
    store: DictionaryStore


def trial(lexicon: Dictionary, strategy: Strategy, *, full_hints: bool) -> Trial:
    calls = Calls()

    @lru_cache(maxsize=CACHE_SIZE)
    def cached(text: str) -> tuple[TokenChain, ...]:
        return analyze(lexicon, strategy, text, calls, reuse_a=full_hints)

    @lru_cache(maxsize=CACHE_SIZE)
    def normalized(text: str) -> TokenChain:
        return analyze(lexicon, "A", text, calls)[0]

    def normalized_tokens(text: str) -> TokenChain:
        return cached(text)[0] if strategy == "A" else normalized(text)

    def clear() -> None:
        cached.cache_clear()
        normalized.cache_clear()

    service = source(strategy, cached, normalized_tokens, full_hints=full_hints)
    store = cast(DictionaryStore, MemoryStore(service.key))
    return Trial(cached, clear, calls, service, store)


async def run_stage(current: Trial, stage: str, request: DictionaryLookupRequest) -> object:
    if stage == "analysis":
        return current.analysis(bounded_text(request)[1])
    if stage == "candidates":
        return current.service.candidates(request)
    return await current.service.lookup(current.store, request)


async def timings(
    trials: dict[Strategy, Trial],
    requests: list[DictionaryLookupRequest],
    repetitions: int,
    *,
    full_hints: bool,
) -> dict[str, object]:
    rng = random.Random(1004)
    results: dict[str, object] = {}
    for stage in STAGES:
        if full_hints and stage == "analysis":
            continue
        valid = dict(trials)
        if stage != "analysis":
            valid.pop("3 tokenize", None)
        for hit in (False, True):
            measurements: dict[Strategy, list[tuple[int, int, int]]] = {key: [] for key in valid}
            for current in valid.values():
                current.clear_cache()
                for request in requests:
                    await run_stage(current, stage, request)
            for _ in range(repetitions):
                batch = list(requests)
                rng.shuffle(batch)
                for request in batch:
                    order = list(valid)
                    rng.shuffle(order)
                    for strategy in order:
                        current = valid[strategy]
                        if not hit:
                            current.clear_cache()
                        previous_calls = current.calls.tokenize
                        clock, cpu = time.perf_counter_ns(), time.process_time_ns()
                        await run_stage(current, stage, request)
                        cpu_elapsed = time.process_time_ns() - cpu
                        clock_elapsed = time.perf_counter_ns() - clock
                        measurements[strategy].append(
                            (
                                clock_elapsed,
                                cpu_elapsed,
                                current.calls.tokenize - previous_calls,
                            )
                        )
            results[f"{stage}:{'hot' if hit else 'cold'}"] = {
                strategy: {
                    "wall_ns": distribution([point[0] for point in points]),
                    "process_cpu_ns": distribution([point[1] for point in points]),
                    "tokenize_calls": distribution([point[2] for point in points]),
                }
                for strategy, points in measurements.items()
            }
    return results


async def memory(
    trials: dict[Strategy, Trial], requests: list[DictionaryLookupRequest]
) -> dict[str, object]:
    results: dict[str, object] = {}
    for stage in STAGES:
        for hit in (False, True):
            peaks: dict[Strategy, object] = {}
            for strategy in STRATEGIES:
                current = trials[strategy]
                per_request: list[int] = []
                for request in requests:
                    current.clear_cache()
                    if hit:
                        await run_stage(current, stage, request)
                    gc.collect()
                    tracemalloc.start()
                    baseline_bytes, _ = tracemalloc.get_traced_memory()
                    result = await run_stage(current, stage, request)
                    _, peak = tracemalloc.get_traced_memory()
                    tracemalloc.stop()
                    del result
                    per_request.append(peak - baseline_bytes)
                peaks[strategy] = distribution(per_request)
            results[f"{stage}:{'hot' if hit else 'cold'}"] = peaks
    retained: dict[Strategy, int] = {}
    for strategy in STRATEGIES:
        current = trials[strategy]
        current.clear_cache()
        gc.collect()
        tracemalloc.start()
        for text in {bounded_text(request)[1] for request in requests}:
            current.analysis(text)
        retained[strategy] = tracemalloc.get_traced_memory()[0]
        tracemalloc.stop()
    results["analysis_cache_python_bytes"] = retained
    return results


def cards(response: DictionaryLookupResponse) -> list[dict[str, object]]:
    return [
        {
            "term": card.term,
            "reading": card.reading,
            "span": [card.start, card.end],
            "surface": card.surface,
            "inflection": [part.model_dump() for part in card.inflection],
        }
        for card in response.matches
    ]


async def outcomes(
    trials: dict[Strategy, Trial], requests: list[DictionaryLookupRequest]
) -> dict[str, object]:
    candidates: dict[Strategy, list[int]] = {strategy: [] for strategy in STRATEGIES}
    keys: dict[Strategy, list[int]] = {strategy: [] for strategy in STRATEGIES}
    samples: dict[str, dict[Strategy, list[dict[str, object]]]] = {}
    for sample, request in zip(SAMPLES, requests, strict=True):
        samples[sample.name] = {}
        for strategy in STRATEGIES:
            current = trials[strategy]
            found = current.service.candidates(request)
            assert all(0 < item.end - item.start <= 32 for item in found)
            candidates[strategy].append(len(found))
            keys[strategy].append(len({item.key for item in found}))
            response = await current.service.lookup(current.store, request)
            assert all(
                request.text[match.start : match.end] == match.surface for match in response.matches
            )
            samples[sample.name][strategy] = cards(response)

    same_span = samples["three-granularities"]
    assert same_span["A"][0]["term"] == same_span["C"][0]["term"] == "外国人参政権"
    assert (
        next(card for card in same_span["C+B/A"] if card["term"] == "外国人")["reading"]
        == "がいこくじん"
    )
    assert (
        next(card for card in same_span["A"] if card["term"] == "外国人")["reading"]
        == "がいこくにん"
    )
    literal = samples["literal-compound"]
    assert literal["A"] == literal["C"] == literal["C+B/A"]
    assert [card["term"] for card in literal["A"]] == ["国際連合大学", "連合"]
    spelling = samples["alternate-spelling"]
    assert not spelling["A"]
    assert spelling["C"] == spelling["C+B/A"]
    assert spelling["C"][0]["term"] == "思い出す"
    inner = samples["a-inner-inflection"]
    assert any(card["term"] == "込む" and card["surface"] == "込んだ" for card in inner["A"])
    assert any(card["term"] == "込む" and card["surface"] == "込んだ" for card in inner["C+B/A"])
    assert not any(card["term"] == "込む" and card["surface"] == "込んだ" for card in inner["C"])
    for sample in (
        "auxiliary",
        "kana",
        "suru",
        "contracted",
        "passive",
        "adjective",
        "potential",
        "teiru",
        "masu",
    ):
        assert samples[sample]["C+B/A"][0] == samples[sample]["A"][0], sample

    return {
        "candidates": {strategy: distribution(values) for strategy, values in candidates.items()},
        "keys": {strategy: distribution(values) for strategy, values in keys.items()},
        "paired_delta_candidates_vs_a": {
            strategy: distribution(
                [value - a for value, a in zip(candidates[strategy], candidates["A"], strict=True)]
            )
            for strategy in ("C", "C+B/A")
        },
        "samples": samples,
    }


async def main(repetitions: int) -> dict[str, object]:
    lexicon = Dictionary(dict="core")
    try:
        plain = [request_for(sample, lexicon, full_hints=False) for sample in SAMPLES]
        hinted = [request_for(sample, lexicon, full_hints=True) for sample in SAMPLES]
        regular: dict[Strategy, Trial] = {
            strategy: trial(lexicon, strategy, full_hints=False)
            for strategy in (*STRATEGIES, "3 tokenize")
        }
        with_hints: dict[Strategy, Trial] = {
            strategy: trial(lexicon, strategy, full_hints=True) for strategy in STRATEGIES
        }
        assert all(with_hints["A"].service.complete_tokens(request) for request in hinted)
        counts = Calls()
        morphology_matches: dict[str, bool] = {}
        for sample, request in zip(SAMPLES, plain, strict=True):
            text = bounded_text(request)[1]
            before = counts.tokenize
            split = analyze(lexicon, "C+B/A", text, counts)
            assert counts.tokenize - before == 1
            direct = analyze(lexicon, "3 tokenize", text, Calls())
            morphology_matches[sample.name] = split == direct
        assert all(morphology_matches.values())
        return {
            "environment": {
                "python": platform.python_version(),
                "platform": platform.platform(),
                "sudachipy": version("SudachiPy"),
                "sudachidict-core": version("SudachiDict-core"),
                "baseline_ref": BASELINE_REF,
            },
            "corpus": {
                "samples": len(SAMPLES),
                "distinct_bounded_texts": len({bounded_text(request)[1] for request in plain}),
                "entries": len(ENTRIES),
                "repetitions": repetitions,
                "memory_repetitions": 1,
                "context_limit_each_side": CONTEXT,
                "window_codepoints": distribution(
                    [len(bounded_text(request)[1]) for request in plain]
                ),
                "cache_size": CACHE_SIZE,
            },
            "split_calls": {
                "tokenize_calls": counts.tokenize,
                "morpheme_split_calls": counts.split,
                "against_independent_tokenize_exact": morphology_matches,
            },
            "timing_no_hints": await timings(regular, plain, repetitions, full_hints=False),
            "timing_complete_a_hints": await timings(
                with_hints, hinted, repetitions, full_hints=True
            ),
            "memory_no_hints": await memory(regular, plain),
            "outcomes_no_hints": await outcomes(regular, plain),
            "outcomes_complete_a_hints": await outcomes(with_hints, hinted),
        }
    finally:
        lexicon.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repetitions", type=int, default=25)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.repetitions < 1:
        parser.error("--repetitions must be positive")
    report = asyncio.run(main(args.repetitions))
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)
