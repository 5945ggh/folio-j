"""Check directory-package extraction without running a native compiler."""

from __future__ import annotations

import importlib.util
import os
import subprocess
import tarfile
from pathlib import Path
from typing import Any
from unittest.mock import Mock
from zipfile import ZipFile

import pytest
from support_paths import symlink_or_skip

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("package_frozen", ROOT / "scripts/package_frozen.py")
assert spec is not None and spec.loader is not None
packager: Any = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


@pytest.mark.parametrize("produces_index", [True, False], ids=["fresh", "missing"])
def test_frozen_build_never_uses_existing_dist(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, produces_index: bool
) -> None:
    existing = tmp_path / "frontend/dist"
    existing.mkdir(parents=True)
    (existing / "index.html").write_text("stale")
    (tmp_path / "backend/alembic").mkdir(parents=True)
    monkeypatch.setattr(packager, "ROOT", tmp_path)
    monkeypatch.setattr(packager, "git", Mock(return_value="fixture"))
    monkeypatch.setattr(packager.importlib.metadata, "version", Mock(return_value="fixture"))
    monkeypatch.setattr(packager.shutil, "which", Mock(return_value="pnpm"))

    def run(arguments: list[str], *, cwd: Path, check: bool, **_kwargs: object) -> None:
        assert check
        if arguments[0] == "pnpm":
            assert cwd == tmp_path / "frontend"
            assert arguments[1:-1] == ["run", "build", "--outDir"]
            frontend = Path(arguments[-1])
            assert not frontend.exists()
            if produces_index:
                frontend.mkdir()
                (frontend / "index.html").write_text("fresh")
            return
        assert produces_index and "PyInstaller" in arguments
        suffix = f"{os.pathsep}frontend/dist"
        (source,) = [Path(arg.removesuffix(suffix)) for arg in arguments if arg.endswith(suffix)]
        assert (source / "index.html").read_text() == "fresh"
        raise subprocess.CalledProcessError(1, "compiler fixture")

    monkeypatch.setattr(packager.subprocess, "run", run)
    output = tmp_path / "output"
    if produces_index:
        with pytest.raises(subprocess.CalledProcessError, match="compiler fixture"):
            packager.build("trial", output)
    else:
        with pytest.raises(ValueError, match="index.html"):
            packager.build("trial", output)
    assert (existing / "index.html").read_text() == "stale"
    assert not output.exists()


def test_windows_zip_extracts_complete_directory_with_unicode_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(packager.platform, "system", lambda: "Windows")
    monkeypatch.setattr(packager.platform, "machine", lambda: "AMD64")
    bundle = tmp_path / "Folio-J"
    (bundle / "_internal/日文 𠮷").mkdir(parents=True)
    (bundle / "config").mkdir()
    payloads = {
        "Folio-J.exe": b"executable fixture",
        "_internal/日文 𠮷/system.dic": b"dictionary fixture",
        "BUILD.json": b'{"commit": "fixture", "dirty": false}',
        "LICENSE": b"license fixture",
    }
    for name, content in payloads.items():
        (bundle / name).write_bytes(content)

    archive = packager.archive_bundle(bundle, "windows-trial")
    assert archive.name == "Folio-J-windows-trial-windows-AMD64.zip"
    destination = tmp_path / "解压后的 程序"
    with ZipFile(archive) as zipped:
        assert all(name.startswith("Folio-J/") for name in zipped.namelist())
        assert zipped.testzip() is None
        zipped.extractall(destination)
    assert (destination / "Folio-J/config").is_dir()
    for name, content in payloads.items():
        assert (destination / "Folio-J" / name).read_bytes() == content


@pytest.mark.skipif(os.name == "nt", reason="POSIX executable mode bits require a POSIX filesystem")
def test_posix_archive_preserves_executable_permissions_and_symlinks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(packager.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(packager.platform, "machine", lambda: "arm64")
    bundle = tmp_path / "Folio-J"
    bundle.mkdir()
    binary = bundle / "Folio-J"
    binary.write_bytes(b"executable fixture")
    binary.chmod(0o755)
    symlink_or_skip(bundle / "linked-binary", "Folio-J")

    archive = packager.archive_bundle(bundle, "posix-trial")
    assert archive.name == "Folio-J-posix-trial-darwin-arm64.tar.gz"
    with tarfile.open(archive) as tarred:
        assert tarred.getmember("Folio-J/Folio-J").mode & 0o111
        link = tarred.getmember("Folio-J/linked-binary")
        assert link.issym()
        assert link.linkname == "Folio-J"
