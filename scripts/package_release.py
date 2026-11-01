"""Build a deterministic source ZIP using only blobs from an explicit Git revision."""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path, PurePosixPath
from typing import TypedDict, cast
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = "scripts/release/manifest.json"


class Manifest(TypedDict):
    files: list[str]
    directories: list[str]
    exclude: list[str]
    templates: dict[str, str]


def git(repository: Path, *args: str) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(repository), *args], capture_output=True, check=False
    )
    if result.returncode:
        raise ValueError(result.stderr.decode(errors="replace").strip())
    return result.stdout


def safe_path(value: str) -> str:
    path = PurePosixPath(value)
    if (
        not value
        or "\\" in value
        or path.is_absolute()
        or ".." in path.parts
        or str(path) != value
    ):
        raise ValueError(f"发行清单路径无效：{value!r}")
    return value


def read_manifest(repository: Path, commit: str) -> Manifest:
    parsed: object = json.loads(git(repository, "show", f"{commit}:{MANIFEST}"))
    if not isinstance(parsed, dict):
        raise TypeError("发行清单应为 JSON 对象。")
    data = cast(dict[str, object], parsed)
    if set(data) != {"files", "directories", "exclude", "templates"}:
        raise ValueError("发行清单需要 files、directories、exclude、templates。")
    for field in ("files", "directories", "exclude"):
        values = data[field]
        if not isinstance(values, list) or not all(
            isinstance(value, str) for value in cast(list[object], values)
        ):
            raise ValueError(f"发行清单 {field} 应为字符串列表。")
    templates = data["templates"]
    if not isinstance(templates, dict) or not all(
        isinstance(key, str) and isinstance(value, str)
        for key, value in cast(dict[object, object], templates).items()
    ):
        raise ValueError("发行清单 templates 应为源路径到目标路径的映射。")
    return cast(Manifest, data)


def build_release(
    repository: Path, ref: str, version: str | None, output: Path
) -> tuple[str, str]:
    commit = git(
        repository, "rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}"
    )
    commit_id = commit.decode().strip()
    if version is None:
        tag = ref.removeprefix("refs/tags/")
        tagged = (
            git(
                repository,
                "rev-parse",
                "--verify",
                "--end-of-options",
                f"refs/tags/{tag}^{{commit}}",
            )
            .decode()
            .strip()
        )
        if tagged != commit_id:
            raise ValueError("请使用精确 tag，或用 --version 明确命名候选提交。")
        version = tag.removeprefix("v")
    if not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z.+_-]*", version):
        raise ValueError("版本名只能包含字母、数字、点、加号、下划线和连字符。")
    manifest = read_manifest(repository, commit_id)
    tree: dict[str, tuple[str, str]] = {}
    for entry in git(repository, "ls-tree", "-rz", "--full-tree", commit_id).split(
        b"\0"
    ):
        if not entry:
            continue
        metadata, raw_path = entry.split(b"\t", 1)
        mode, kind, oid = metadata.decode().split()
        if kind == "blob":
            tree[raw_path.decode()] = (mode, oid)
    selected = {safe_path(path): safe_path(path) for path in manifest["files"]}
    for directory in manifest["directories"]:
        prefix = safe_path(directory) + "/"
        matches = [path for path in tree if path.startswith(prefix)]
        if not matches:
            raise ValueError(f"发行目录不存在或为空：{directory}")
        for path in matches:
            if not any(
                fnmatch.fnmatchcase(path, pattern) for pattern in manifest["exclude"]
            ):
                selected[safe_path(path)] = path
    for source, destination in manifest["templates"].items():
        destination = safe_path(destination)
        if destination in selected:
            raise ValueError(f"发行路径重复：{destination}")
        selected[destination] = safe_path(source)
    if "RELEASE.json" in selected:
        raise ValueError("RELEASE.json 由打包器生成。")
    payloads: dict[str, tuple[bytes, str]] = {}
    for destination, source in sorted(selected.items()):
        if source not in tree:
            raise ValueError(f"指定提交缺少发行文件：{source}")
        mode, oid = tree[source]
        if mode not in {"100644", "100755"}:
            raise ValueError(f"发行包不接收符号链接或特殊文件：{source}")
        payloads[destination] = (git(repository, "cat-file", "blob", oid), mode)
    payloads["RELEASE.json"] = (
        (
            json.dumps({"version": version, "commit": commit_id}, indent=2) + "\n"
        ).encode(),
        "100644",
    )
    prefix = f"Folio-J-{version}/"
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=output.parent,
            prefix=f".{output.name}.",
            suffix=".tmp",
            delete=False,
        ) as stream:
            temporary = Path(stream.name)
            with ZipFile(stream, "w", compression=ZIP_DEFLATED) as archive:
                for name, (data, mode) in sorted(payloads.items()):
                    info = ZipInfo(prefix + name, date_time=(2020, 1, 1, 0, 0, 0))
                    info.create_system = 3
                    info.external_attr = int(mode, 8) << 16
                    info.compress_type = ZIP_DEFLATED
                    archive.writestr(info, data)
        os.link(temporary, output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return version, commit_id


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", required=True, help="明确的 Git commit 或 tag")
    parser.add_argument("--version", help="候选提交的版本名；精确 tag 可省略")
    parser.add_argument(
        "--output", required=True, type=Path, help="尚不存在的 ZIP 路径"
    )
    args = parser.parse_args()
    try:
        version, commit = build_release(ROOT, args.ref, args.version, args.output)
    except (TypeError, ValueError, OSError) as error:
        parser.exit(1, f"无法打包：{error}\n")
    print(f"源码发行包：{args.output.resolve()}\n版本：{version}\n提交：{commit}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
