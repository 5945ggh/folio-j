"""Build an experimental PyInstaller directory bundle from the working tree."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
from typing import Any
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]


def git(*arguments: str) -> str:
    return subprocess.check_output(
        ["git", "-C", str(ROOT), *arguments], text=True, stderr=subprocess.PIPE
    ).strip()


def file_sizes(directory: Path) -> dict[str, int]:
    """Count regular files once; framework symlinks must not inflate the result."""
    files = [
        path
        for path in directory.rglob("*")
        if path.is_file() and not path.is_symlink()
    ]
    return {
        "files": len(files),
        "bytes": sum(path.stat().st_size for path in files),
        "allocated_bytes": sum(
            getattr(path.stat(), "st_blocks", 0) * 512 for path in files
        ),
    }


def third_party_notices() -> str:
    sections = [
        (
            "Folio-J experimental directory distribution\n"
            "Build-environment dependency versions and supplied license notices.\n"
            "This list also includes build tools that may not be shipped in the bundle.\n"
        )
    ]
    for distribution in sorted(
        importlib.metadata.distributions(),
        key=lambda item: item.metadata["Name"].lower(),
    ):
        name = distribution.metadata["Name"]
        sections.append(f"\n{'=' * 72}\n{name} {distribution.version}\n")
        for key in ("License-Expression", "License", "Home-page"):
            if value := distribution.metadata[key]:
                sections.append(f"{key}: {value}\n")
        for file in distribution.files or ():
            if file.name.lower().startswith(("license", "copying", "notice")):
                path = Path(str(distribution.locate_file(file)))
                if path.is_file():
                    sections.append(
                        f"\n--- {file} ---\n{path.read_text(errors='replace')}\n"
                    )
    for name in ("LICENSE", "LICENSE.txt"):
        path = Path(sys.base_prefix) / name
        if path.is_file():
            sections.append(
                f"\n--- Python {name} ---\n{path.read_text(errors='replace')}\n"
            )
    return "".join(sections)


def archive_bundle(bundle: Path, version: str) -> Path:
    """Ship Windows as ZIP; preserve POSIX executable bits and symlinks in tar."""
    target = platform.system()
    extension = "zip" if target == "Windows" else "tar.gz"
    archive_path = bundle.parent / (
        f"Folio-J-{version}-{target.lower()}-{platform.machine()}.{extension}"
    )
    if target == "Windows":
        with ZipFile(archive_path, "w", compression=ZIP_DEFLATED) as archive:
            for path in sorted(bundle.rglob("*")):
                archive.write(path, path.relative_to(bundle.parent).as_posix())
    else:
        with tarfile.open(archive_path, "w:gz") as archive:
            archive.add(bundle, arcname="Folio-J")
    return archive_path


def build(version: str, output: Path) -> dict[str, Any]:
    if not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z.+_-]*", version):
        raise ValueError("版本名只能包含字母、数字、点、加号、下划线和连字符。")
    if output.exists():
        raise ValueError(f"输出目录已存在，请使用新目录：{output}")
    importlib.metadata.version("pyinstaller")
    frontend = ROOT / "frontend/dist"
    if not (frontend / "index.html").is_file():
        raise ValueError("缺少前端产物，请先运行 just build。")
    output.parent.mkdir(parents=True, exist_ok=True)
    identity = {
        "version": version,
        "commit": git("rev-parse", "HEAD"),
        "dirty": bool(git("status", "--porcelain", "--untracked-files=normal")),
        "distribution": "pyinstaller-onedir-experiment",
        "platform": platform.system(),
        "architecture": platform.machine(),
        "python": platform.python_version(),
        "pyinstaller": importlib.metadata.version("pyinstaller"),
        "sudachipy": importlib.metadata.version("sudachipy"),
        "sudachidict_core": importlib.metadata.version("sudachidict-core"),
    }
    with tempfile.TemporaryDirectory(prefix="folio-j-frozen-") as temporary:
        stage = Path(temporary)
        release = stage / "RELEASE.json"
        release.write_text(
            json.dumps({key: identity[key] for key in ("version", "commit")}, indent=2)
            + "\n",
            encoding="utf-8",
        )
        migrations = stage / "alembic"
        shutil.copytree(
            ROOT / "backend/alembic",
            migrations,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        arguments = [
            sys.executable,
            "-m",
            "PyInstaller",
            "--onedir",
            "--name",
            "Folio-J",
            "--noupx",
            "--clean",
            "--distpath",
            str(stage / "dist"),
            "--workpath",
            str(stage / "work"),
            "--specpath",
            str(stage),
            "--paths",
            str(ROOT / "backend/src"),
            "--collect-submodules",
            "app",
            "--collect-submodules",
            "sqlalchemy.dialects.sqlite",
            "--collect-data",
            "sudachipy",
            "--collect-data",
            "sudachidict_core",
            "--copy-metadata",
            "sudachipy",
            "--copy-metadata",
            "sudachidict-core",
            "--hidden-import",
            "uvicorn.logging",
            "--hidden-import",
            "uvicorn.loops.asyncio",
            "--hidden-import",
            "uvicorn.protocols.http.h11_impl",
            "--hidden-import",
            "uvicorn.lifespan.on",
            "--hidden-import",
            "aiosqlite",
        ]
        for source, destination in (
            (ROOT / "backend/prompts", "backend/prompts"),
            (migrations, "backend/alembic"),
            (ROOT / "backend/alembic.ini", "backend"),
            (frontend, "frontend/dist"),
            (release, "."),
        ):
            arguments.extend(["--add-data", f"{source}{os.pathsep}{destination}"])
        arguments.append(str(ROOT / "scripts/frozen/entry.py"))
        environment = os.environ.copy()
        environment["PYINSTALLER_CONFIG_DIR"] = str(ROOT / ".cache/pyinstaller")
        subprocess.run(arguments, cwd=ROOT, env=environment, check=True)
        bundle = stage / "dist/Folio-J"
        shutil.copy2(release, bundle / "RELEASE.json")
        (bundle / "BUILD.json").write_text(
            json.dumps(identity, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        shutil.copy2(ROOT / "scripts/frozen/README.md", bundle / "README.md")
        for name in ("LICENSE", "COPYING.md"):
            shutil.copy2(ROOT / name, bundle / name)
        (bundle / "THIRD_PARTY_NOTICES.txt").write_text(
            third_party_notices(), encoding="utf-8"
        )
        (bundle / "config").mkdir()
        shutil.copy2(
            ROOT / "config/app.example.toml", bundle / "config/app.example.toml"
        )
        summary: dict[str, Any] = {"release": identity, "bundle": file_sizes(bundle)}
        summary["dictionary"] = file_sizes(bundle / "_internal/sudachidict_core")
        summary["frontend"] = file_sizes(bundle / "_internal/frontend/dist")
        archive_path = archive_bundle(bundle, version)
        summary["archive"] = {
            "name": archive_path.name,
            "bytes": archive_path.stat().st_size,
        }
        (stage / "dist/SIZE.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        shutil.copytree(stage / "dist", output, symlinks=True)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--output", type=Path, required=True, help="尚不存在的输出目录")
    arguments = parser.parse_args()
    try:
        summary = build(arguments.version, arguments.output.resolve())
    except (
        ValueError,
        OSError,
        subprocess.CalledProcessError,
        importlib.metadata.PackageNotFoundError,
    ) as error:
        parser.exit(1, f"目录包构建失败：{error}\n")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
