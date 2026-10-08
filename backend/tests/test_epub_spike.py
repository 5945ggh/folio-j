"""Contract checks for the isolated EPUB experiment; no network or model calls."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any, cast

import pytest

ROOT = Path(__file__).resolve().parents[2]


def load_script(name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


compiler = load_script("epub_spike")
fixtures = load_script("make_epub_fixtures")


def compile_fixture(tmp_path: Path, **kwargs: Any) -> dict[str, Any]:
    path = tmp_path / "sample.epub"
    fixtures.build_fixture(path, **kwargs)
    return cast(dict[str, Any], compiler.compile_epub(path))


def test_legacy_cli_contract_remains_readable_by_experiment(tmp_path: Path) -> None:
    book = compile_fixture(tmp_path)
    assert book["contract"] == "epub-spike-v1"
    assert "materialVersion" in book
    assert "htmlAttributes" in book["resources"][0]
    assert "textSha256" in book["resources"][0]


def test_legacy_cli_missing_input_reports_friendly_error(tmp_path: Path) -> None:
    with pytest.raises(compiler.EpubError, match="无法读取 EPUB 文件"):
        compiler.compile_epub(tmp_path / "missing.epub")
