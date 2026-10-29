"""Read a local Yomitan dictionary and print structural statistics, without definitions."""

from __future__ import annotations

import argparse
import hashlib
import json
import zipfile
from collections import Counter, defaultdict
from collections.abc import Iterator
from pathlib import Path
from typing import Any


def objects(value: Any) -> Iterator[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from objects(child)
    elif isinstance(value, list):
        for child in value:
            yield from objects(child)


def inspect(path: Path) -> dict[str, Any]:
    row_count = 0
    empty_readings = 0
    sequence_hashes: dict[int, set[str]] = defaultdict(set)
    expressions: dict[str, set[int]] = defaultdict(set)
    classes: Counter[str] = Counter()
    coverage: Counter[str] = Counter()
    scores: Counter[str] = Counter()
    selected: dict[str, list[dict[str, Any]]] = defaultdict(list)
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        index = json.loads(archive.read("index.json"))
        banks = sorted(name for name in names if name.startswith("term_bank_"))
        for bank in banks:
            for row in json.loads(archive.read(bank)):
                if len(row) != 8:
                    raise ValueError(f"Unexpected row length in {bank}")
                expression, reading, _, _, score, definitions, sequence, _ = row
                row_count += 1
                empty_readings += not reading
                expressions[expression].add(sequence)
                scores[str(score)] += 1
                digest = hashlib.sha256(
                    json.dumps(definitions, ensure_ascii=False).encode()
                ).hexdigest()
                if sequence not in sequence_hashes:
                    counts = Counter(
                        node.get("data", {}).get("class", "")
                        for node in objects(definitions)
                    )
                    counts.pop("", None)
                    classes.update(counts)
                    coverage.update(counts.keys())
                sequence_hashes[sequence].add(digest)
                if expression in {"生", "人気", "上手", "明日", "開く", "掛ける"}:
                    selected[expression].append(
                        {"reading": reading, "sequence": sequence}
                    )
        uncompressed_bytes = sum(info.file_size for info in archive.infolist())
    return {
        "file_name": path.name,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "zip_bytes": path.stat().st_size,
        "uncompressed_bytes": uncompressed_bytes,
        "index": index,
        "archive_files": len(names),
        "term_banks": len(banks),
        "rows": row_count,
        "sequences": len(sequence_hashes),
        "sequences_with_different_definition_payloads": sum(
            len(hashes) > 1 for hashes in sequence_hashes.values()
        ),
        "empty_reading_rows": empty_readings,
        "unique_expressions": len(expressions),
        "expressions_with_multiple_sequences": sum(
            len(sequences) > 1 for sequences in expressions.values()
        ),
        "scores": dict(scores),
        "class_nodes_deduplicated_by_sequence": dict(classes.most_common()),
        "sequences_containing_class": dict(coverage.most_common()),
        "selected_expression_candidates": dict(selected),
        "caveats": [
            "Class node counts describe this converter's structure, not verified sense counts.",
            "Examples can be fragments or contain placeholders; these are not labeled WSD instances.",
            "Sequence is scoped to this dictionary version and is not a universal sense identifier.",
        ],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dictionary", type=Path)
    args = parser.parse_args()
    print(json.dumps(inspect(args.dictionary), ensure_ascii=False, indent=2))
