"""Exercise documentation path checks in repositories without local evidence."""

import shutil
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.fixture
def repository(tmp_path: Path) -> Path:
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    shutil.copyfile(
        Path(__file__).resolve().parents[2] / "scripts" / "check_docs.py",
        scripts / "check_docs.py",
    )
    (tmp_path / "README.md").write_text("[guide](docs/guide.md)", encoding="utf-8")
    (tmp_path / "AGENTS.md").write_text("", encoding="utf-8")
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "guide.md").write_text(
        "[evidence](../data/acceptance-evidence/screenshot.png)", encoding="utf-8"
    )
    return tmp_path


def run_check(repository: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(repository / "scripts" / "check_docs.py"), *args],
        capture_output=True,
        text=True,
        check=False,
    )


def test_default_reports_private_evidence_as_unverified(repository: Path) -> None:
    result = run_check(repository)
    assert result.returncode == 0, result.stderr
    assert "1 个公共本地链接" in result.stdout
    assert "私有证据已检查 0 个、未核验 1 个" in result.stdout
    assert "全部有效" not in result.stdout


def test_strict_requires_private_evidence(repository: Path) -> None:
    result = run_check(repository, "--private-evidence")
    assert result.returncode == 1
    assert "私有证据已检查 1 个、未核验 0 个" in result.stdout
    assert "docs/guide.md: ../data/acceptance-evidence/screenshot.png" in result.stdout

    evidence = repository / "data" / "acceptance-evidence" / "screenshot.png"
    evidence.parent.mkdir(parents=True)
    evidence.touch()
    result = run_check(repository, "--private-evidence")
    assert result.returncode == 0, result.stderr
    assert "1 个公共本地链接" in result.stdout
    assert "私有证据已检查 1 个、未核验 0 个" in result.stdout


@pytest.mark.parametrize("args", [(), ("--private-evidence",)])
@pytest.mark.parametrize(
    "document",
    [
        "docs/broken.md",
        "docs/handovers/archived/broken.md",
        "references/sample/README.md",
        "prototypes/sample/README.md",
    ],
)
def test_public_missing_links_fail_in_both_modes(
    repository: Path, document: str, args: tuple[str, ...]
) -> None:
    path = repository / document
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("[broken](missing.md)", encoding="utf-8")
    result = run_check(repository, *args)
    assert result.returncode == 1
    assert f"{document}: missing.md" in result.stdout


@pytest.mark.parametrize(
    "target",
    [
        "../data/acceptance-evidence/../missing.png",
        "../data/acceptance-evidence/%2e%2e/missing.png",
        "../data/acceptance-evidence/%2e%2e%2fmissing.png",
        "../data/acceptance-evidence-other/missing.png",
        "../data/%61cceptance-evidence/../../missing.png",
    ],
)
def test_normalized_paths_outside_private_evidence_are_public(
    repository: Path, target: str
) -> None:
    (repository / "docs" / "guide.md").write_text(f"[broken]({target})", encoding="utf-8")
    result = run_check(repository)
    assert result.returncode == 1
    assert "2 个公共本地链接" in result.stdout
    assert "未核验 0 个" in result.stdout
    assert f"docs/guide.md: {target}" in result.stdout


def test_encoded_private_path_is_classified_after_normalization(repository: Path) -> None:
    (repository / "docs" / "guide.md").write_text(
        "[evidence](<../data/%61cceptance-evidence/a%20b.png#details>)", encoding="utf-8"
    )
    result = run_check(repository)
    assert result.returncode == 0, result.stderr
    assert "私有证据已检查 0 个、未核验 1 个" in result.stdout
    result = run_check(repository, "--private-evidence")
    assert result.returncode == 1
    evidence = repository / "data" / "acceptance-evidence" / "a b.png"
    evidence.parent.mkdir(parents=True)
    evidence.touch()
    assert run_check(repository, "--private-evidence").returncode == 0


def test_symlink_outside_private_directory_is_public(repository: Path) -> None:
    evidence = repository / "data" / "acceptance-evidence"
    evidence.mkdir(parents=True)
    (evidence / "outside").symlink_to(repository / "docs", target_is_directory=True)
    (repository / "docs" / "guide.md").write_text(
        "[broken](../data/acceptance-evidence/outside/missing.png)", encoding="utf-8"
    )
    result = run_check(repository)
    assert result.returncode == 1
    assert "2 个公共本地链接" in result.stdout
    assert "未核验 0 个" in result.stdout
