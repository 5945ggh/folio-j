"""Mechanical validation of this pilot batch; uses only the Python standard library."""

from __future__ import annotations

import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
KINDS = {"lexis", "grammar", "expression", "other"}
TAGS = {"conjugation", "omission", "contrast", "register", "pronunciation"}
SLOTS = {"N", "V-辞", "V-て", "V-た", "V-ない", "A-い", "A-な", "S"}
TOP_FIELDS = {"case_id", "sample_id", "item"}
ITEM_FIELDS = {"kind", "title", "surface_refs", "anchors", "gloss", "tags", "section_refs"}
UNCHECKED = [
    "解析是否真正支持学习点、gloss、类型、标签及 anchor 还原",
    "Surface 是否足够短且完整，Occurrence 粒度是否适于独立收录",
    "日语固定成分、槽位接续、语义等价及相同 anchor 的知识点同一性",
    "目标与解析间的转写差异、第一阶段讲解正误及提示词实际版本",
]


def exact_matches(haystack: str, needle: str) -> list[tuple[int, int]]:
    """Return overlapping Python str codepoint spans."""
    positions: list[tuple[int, int]] = []
    start = 0
    while True:
        index = haystack.find(needle, start)
        if index < 0:
            return positions
        positions.append((index, index + len(needle)))
        start = index + 1


def check_string(value: Any, name: str, low: int, high: int, failures: list[str]) -> bool:
    if not isinstance(value, str):
        failures.append(f"{name}: expected string")
        return False
    if not low <= len(value) <= high:
        failures.append(f"{name}: length {len(value)} outside {low}..{high}")
        return False
    return True


def validate_manifest(data: Any, failures: list[str]) -> dict[str, dict[str, Any]]:
    if not isinstance(data, dict) or not isinstance(data.get("samples"), list):
        failures.append("manifest: missing samples array")
        return {}
    samples: dict[str, dict[str, Any]] = {}
    all_section_ids: set[str] = set()
    for sample in data["samples"]:
        if not isinstance(sample, dict) or not isinstance(sample.get("sample_id"), str):
            failures.append("manifest: invalid sample")
            continue
        sid = sample["sample_id"]
        if sid in samples:
            failures.append(f"manifest: duplicate sample_id {sid}")
        samples[sid] = sample
        target = sample.get("target_text")
        if not isinstance(target, str) or not target:
            failures.append(f"manifest: {sid} lacks target_text")
            continue
        try:
            source_path = ROOT / sample["snapshot_files"]["source"]
            analysis_path = ROOT / sample["snapshot_files"]["analysis"]
            source = source_path.read_text(encoding="utf-8")
            analysis = analysis_path.read_text(encoding="utf-8")
            for name, path in (("source", source_path), ("analysis", analysis_path)):
                actual = hashlib.sha256(path.read_bytes()).hexdigest()
                if actual != sample["sha256"][name]:
                    failures.append(f"manifest: {sid} {name} snapshot hash mismatch")
            if target not in source:
                failures.append(f"manifest: {sid} target not in source snapshot")
        except (OSError, KeyError, TypeError) as exc:
            failures.append(f"manifest: {sid} snapshot error: {exc}")
            continue
        lines = analysis.splitlines()
        sections = sample.get("section_refs")
        if not isinstance(sections, list) or not sections:
            failures.append(f"manifest: {sid} lacks sections")
            continue
        previous_end = 0
        for section in sections:
            if not isinstance(section, dict):
                failures.append(f"manifest: {sid} invalid section")
                continue
            try:
                ref, start, end = (section[k] for k in ("section_ref", "start_line", "end_line"))
                title = section["title"]
                if not isinstance(ref, str) or ref in all_section_ids:
                    failures.append(f"manifest: duplicate/invalid section_ref {ref}")
                else:
                    all_section_ids.add(ref)
                if not all(isinstance(x, int) and not isinstance(x, bool) for x in (start, end)):
                    failures.append(f"manifest: {ref} noninteger line range")
                    continue
                if not (1 <= start <= end <= len(lines)) or start != previous_end + 1:
                    failures.append(f"manifest: {ref} invalid/noncontiguous line range")
                if title != "[preamble]" and lines[start - 1] != f"## {title}":
                    failures.append(f"manifest: {ref} title mismatch")
                previous_end = end
            except (KeyError, TypeError, IndexError) as exc:
                failures.append(f"manifest: {sid} section error: {exc}")
        if previous_end != len(lines):
            failures.append(f"manifest: {sid} sections do not cover analysis")
    return samples


def validate_case(record: Any, samples: dict[str, dict[str, Any]]) -> dict[str, Any]:
    failures: list[str] = []
    passed: list[str] = []
    positions: list[dict[str, Any]] = []
    result: dict[str, Any] = {"case_id": None, "sample_id": None, "positions": positions,
                              "passed": passed, "failed": failures, "unchecked": UNCHECKED.copy()}
    if not isinstance(record, dict):
        failures.append("record is not object")
        return result
    cid = record.get("case_id")
    sid = record.get("sample_id")
    result["case_id"] = cid
    result["sample_id"] = sid
    if set(record) != TOP_FIELDS:
        failures.append(f"top fields: expected {sorted(TOP_FIELDS)}, got {sorted(record)}")
    if not check_string(cid, "case_id", 1, 80, failures):
        cid = None
    if not isinstance(sid, str) or sid not in samples:
        failures.append(f"unknown sample_id: {sid}")
    elif isinstance(cid, str) and not cid.startswith(sid + "-o"):
        failures.append("case_id prefix does not match sample_id")
    item = record.get("item")
    if not isinstance(item, dict):
        failures.append("item is not object")
        return result
    if set(item) != ITEM_FIELDS:
        failures.append(f"item fields: expected {sorted(ITEM_FIELDS)}, got {sorted(item)}")
    if item.get("kind") not in KINDS:
        failures.append("invalid kind")
    check_string(item.get("title"), "title", 1, 80, failures)
    check_string(item.get("gloss"), "gloss", 1, 300, failures)
    tags = item.get("tags")
    if not isinstance(tags, list) or any(not isinstance(t, str) or t not in TAGS for t in tags):
        failures.append("invalid tags")
    elif len(tags) != len(set(tags)):
        failures.append("duplicate tags")
    else:
        passed.append("tag enum and uniqueness")
    anchors = item.get("anchors")
    if not isinstance(anchors, list) or not 1 <= len(anchors) <= 3:
        failures.append("anchors must contain 1..3 items")
    else:
        keys: list[tuple[str, str]] = []
        for i, anchor in enumerate(anchors):
            if not check_string(anchor, f"anchors[{i}]", 1, 80, failures):
                continue
            if anchor != anchor.strip() or "\n" in anchor or "`" in anchor:
                failures.append(f"anchors[{i}]: whitespace/fence format")
            if anchor.startswith(("「", "『", '"')) or anchor.endswith(("」", "』", '"')):
                failures.append(f"anchors[{i}]: display quotes included")
            if "+" in anchor:
                parts = anchor.split(" + ")
                if len(parts) < 2 or any(not p or "+" in p for p in parts):
                    failures.append(f"anchors[{i}]: connector must be ' + '")
                for part in parts:
                    if re.fullmatch(r"[A-Z](?:-[^ ]+)?", part) and part not in SLOTS:
                        failures.append(f"anchors[{i}]: unsupported slot {part}")
            keys.append((str(item.get("kind")), unicodedata.normalize("NFKC", anchor).strip()))
        if len(keys) != len(set(keys)):
            failures.append("duplicate normalized anchors within case")
        else:
            passed.append("anchor count, format and normalized uniqueness")
    refs = item.get("section_refs")
    if not isinstance(refs, list) or not refs or any(not isinstance(x, str) for x in refs):
        failures.append("section_refs must be nonempty string array")
    elif not isinstance(sid, str) or sid not in samples:
        failures.append("section_refs cannot resolve without sample")
    else:
        valid = {s["section_ref"] for s in samples[sid]["section_refs"]}
        if len(refs) != len(set(refs)) or any(x not in valid for x in refs):
            failures.append("section_refs duplicate, unknown or foreign")
        else:
            passed.append("section_refs resolve within sample")
    surface_refs = item.get("surface_refs")
    if not isinstance(surface_refs, list) or not surface_refs:
        failures.append("surface_refs must be nonempty array")
    elif isinstance(sid, str) and sid in samples:
        target = samples[sid]["target_text"]
        last_end = -1
        seen_positions: set[tuple[int, int]] = set()
        for i, surface in enumerate(surface_refs):
            if not isinstance(surface, dict) or set(surface) != {"text", "match_index"}:
                failures.append(f"surface_refs[{i}]: invalid fields")
                continue
            value, match_index = surface["text"], surface["match_index"]
            if not isinstance(value, str) or not value:
                failures.append(f"surface_refs[{i}]: empty/nonstring text")
                continue
            matches = exact_matches(target, value)
            if not isinstance(match_index, int) or isinstance(match_index, bool) or match_index < 1 or match_index > len(matches):
                failures.append(f"surface_refs[{i}]: invalid match_index; {len(matches)} exact matches")
                continue
            start, end = matches[match_index - 1]
            positions.append({"text": value, "match_index": match_index, "start": start, "end": end})
            if start < last_end or (start, end) in seen_positions:
                failures.append(f"surface_refs[{i}]: out of order, overlapping or duplicate")
            seen_positions.add((start, end))
            last_end = end
        if len(positions) == len(surface_refs) and not any("surface_refs" in f for f in failures):
            passed.append("surface exact matches, indices, order and nonoverlap")
    if not failures:
        passed.append("required fields, types and length bounds")
    return result


def main() -> int:
    manifest_failures: list[str] = []
    try:
        manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
        samples = validate_manifest(manifest, manifest_failures)
    except (OSError, json.JSONDecodeError) as exc:
        samples = {}
        manifest_failures.append(f"manifest JSON/read error: {exc}")
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    try:
        lines = (ROOT / "occurrences.jsonl").read_text(encoding="utf-8").splitlines()
        for number, line in enumerate(lines, 1):
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                results.append({"line": number, "case_id": None, "positions": [], "passed": [],
                                "failed": [f"JSON error: {exc}"], "unchecked": UNCHECKED.copy()})
                continue
            result = validate_case(record, samples)
            result["line"] = number
            cid = result["case_id"]
            if isinstance(cid, str):
                if cid in seen:
                    result["failed"].append("duplicate case_id")
                seen.add(cid)
            results.append(result)
    except OSError as exc:
        manifest_failures.append(f"occurrences read error: {exc}")
    failed = sum(bool(r["failed"]) for r in results)
    output = {"validator": "validate.py", "manifest_failures": manifest_failures,
              "summary": {"samples": len(samples), "records": len(results), "passed_records": len(results) - failed,
                          "failed_records": failed, "mechanically_valid": not manifest_failures and failed == 0},
              "cases": results,
              "scope_note": "机械校验只验证结构、引用、定位和可判定的 anchor 书写；未检查项不视为通过。"}
    (ROOT / "validation.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(output["summary"], ensure_ascii=False))
    if manifest_failures:
        print("manifest failures:", *manifest_failures, sep="\n", file=sys.stderr)
    return 0 if output["summary"]["mechanically_valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
