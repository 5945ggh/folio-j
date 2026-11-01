"""Exercise public source packaging against real, isolated Git object databases."""

from __future__ import annotations

import importlib.util
import json
import subprocess
from pathlib import Path
from typing import Any
from zipfile import ZipFile

import pytest
from support_paths import symlink_or_skip

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "package_release", ROOT / "scripts/package_release.py"
)
assert spec is not None and spec.loader is not None
packager: Any = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


def git(repository: Path, *args: str) -> str:
    return subprocess.check_output(
        ["git", "-C", str(repository), *args], text=True, stderr=subprocess.PIPE
    ).strip()


def write(repository: Path, name: str, content: str) -> None:
    path = repository / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8", newline="\n")


def commit(repository: Path) -> str:
    git(repository, "add", ".")
    git(
        repository,
        "-c",
        "user.name=Packaging Test",
        "-c",
        "user.email=packaging@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "fixture",
    )
    return git(repository, "rev-parse", "HEAD")


@pytest.fixture
def repository(tmp_path: Path) -> Path:
    repo = tmp_path / "repository"
    repo.mkdir()
    git(repo, "init", "-q")
    git(repo, "config", "core.autocrlf", "false")
    write(
        repo,
        "scripts/release/manifest.json",
        json.dumps(
            {
                "files": ["backend/uv.lock"],
                "directories": ["frontend/src"],
                "exclude": ["*.test.ts", "*/fixtures/*"],
                "templates": {"scripts/release/README.md": "README.md"},
            }
        ),
    )
    write(repo, "scripts/release/README.md", "Public release\n")
    write(repo, "backend/uv.lock", "locked dependencies\n")
    write(repo, "frontend/src/main.ts", "application\n")
    write(repo, "frontend/src/main.test.ts", "private test text\n")
    write(repo, "frontend/src/fixtures/book.json", "private fixture\n")
    write(repo, "data/app.db", "user data\n")
    commit(repo)
    return repo


def test_package_uses_ref_blobs_and_manifest_even_with_dirty_worktree(
    repository: Path, tmp_path: Path
) -> None:
    revision = git(repository, "rev-parse", "HEAD")
    write(repository, "frontend/src/main.ts", "uncommitted application\n")
    write(repository, "scripts/release/README.md", "uncommitted README\n")
    write(repository, "scripts/release/manifest.json", "invalid dirty manifest")
    write(repository, "frontend/src/untracked.ts", "untracked file\n")
    output = tmp_path / "source.zip"
    assert packager.build_release(repository, revision, "0.1-beta.1", output) == (
        "0.1-beta.1",
        revision,
    )
    with ZipFile(output) as archive:
        prefix = "Folio-J-0.1-beta.1/"
        assert set(archive.namelist()) == {
            prefix + name
            for name in ("README.md", "RELEASE.json", "backend/uv.lock", "frontend/src/main.ts")
        }
        assert archive.read(prefix + "frontend/src/main.ts") == b"application\n"
        assert archive.read(prefix + "README.md") == b"Public release\n"
        assert json.loads(archive.read(prefix + "RELEASE.json")) == {
            "version": "0.1-beta.1",
            "commit": revision,
        }


def test_exact_tag_derives_version_and_repeated_packages_match(
    repository: Path, tmp_path: Path
) -> None:
    git(repository, "tag", "v0.1.0-beta.1")
    first, second = tmp_path / "first.zip", tmp_path / "second.zip"
    packager.build_release(repository, "v0.1.0-beta.1", None, first)
    packager.build_release(repository, "refs/tags/v0.1.0-beta.1", None, second)
    assert first.read_bytes() == second.read_bytes()
    with pytest.raises(FileExistsError):
        packager.build_release(repository, "v0.1.0-beta.1", None, first)
    assert first.read_bytes() == second.read_bytes()


def test_commit_requires_explicit_version(repository: Path, tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        packager.build_release(repository, "HEAD", None, tmp_path / "source.zip")
    assert not (tmp_path / "source.zip").exists()


@pytest.mark.parametrize("bad_source", ["missing.md", "../outside.md", "/absolute.md"])
def test_missing_and_unsafe_manifest_entries_leave_no_archive(
    repository: Path, tmp_path: Path, bad_source: str
) -> None:
    manifest_path = repository / "scripts/release/manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["files"].append(bad_source)
    manifest_path.write_text(json.dumps(manifest))
    commit(repository)
    output = tmp_path / "source.zip"
    with pytest.raises(ValueError):
        packager.build_release(repository, "HEAD", "candidate", output)
    assert not output.exists()


def test_symlink_is_rejected_instead_of_followed(repository: Path, tmp_path: Path) -> None:
    symlink_or_skip(repository / "frontend/src/secret.ts", "../../data/app.db")
    commit(repository)
    output = tmp_path / "source.zip"
    with pytest.raises(ValueError, match="符号链接"):
        packager.build_release(repository, "HEAD", "candidate", output)
    assert not output.exists()


def test_interrupted_archive_is_not_published_and_temporary_file_is_removed(
    repository: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    original = ZipFile.writestr

    def interrupt(archive: ZipFile, *args: Any, **kwargs: Any) -> None:
        original(archive, *args, **kwargs)
        raise KeyboardInterrupt

    monkeypatch.setattr(ZipFile, "writestr", interrupt)
    before = set(tmp_path.iterdir())
    output = tmp_path / "source.zip"
    with pytest.raises(KeyboardInterrupt):
        packager.build_release(repository, "HEAD", "candidate", output)
    assert not output.exists()
    assert set(tmp_path.iterdir()) == before
