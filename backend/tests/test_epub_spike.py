"""Contract checks for the isolated EPUB experiment; no network or model calls."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any, cast
from zipfile import ZipFile

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


def test_projection_keeps_base_entities_blocks_and_global_nfc(tmp_path: Path) -> None:
    book = compile_fixture(tmp_path)
    resource = book["resources"][0]
    assert resource["text"] == (
        "第一章\n漢字 & 本。\n同じ言葉。\n同じ言葉。\nがと𠮷、👩\u200d💻。\n前\n後\nＡ①\n"
    )
    assert "<ruby>" in resource["html"] and "<rt>かんじ</rt>" in resource["html"]
    assert "かんじ" not in resource["text"]
    assert "data:image/png;base64," in resource["html"]
    # NFKC is deliberately not used; fullwidth/compatibility source characters survive.
    assert "Ａ①" in resource["text"]


def test_codepoints_and_repeated_text_remain_distinct_positions(tmp_path: Path) -> None:
    text = compile_fixture(tmp_path)["resources"][0]["text"]
    first = text.index("同じ言葉。")
    second = text.index("同じ言葉。", first + 1)
    assert first != second and text[first : first + 6] == text[second : second + 6]
    assert len("𠮷") == 1 and len("👩\u200d💻") == 3
    start = text.index("👩")
    assert text[start : start + 3] == "👩\u200d💻"


def test_output_and_fixture_bytes_are_deterministic(tmp_path: Path) -> None:
    first, second = tmp_path / "a.epub", tmp_path / "b.epub"
    fixtures.build_fixture(first)
    fixtures.build_fixture(second)
    assert first.read_bytes() == second.read_bytes()
    assert compiler.compile_epub(first) == compiler.compile_epub(second)
    original = compiler.compile_epub(first)["materialVersion"]
    fixtures.build_fixture(second, vertical=True)
    assert compiler.compile_epub(second)["materialVersion"] != original


def test_author_styles_do_not_enter_projection(tmp_path: Path) -> None:
    book = compile_fixture(tmp_path, vertical=True)
    assert all("position:absolute" in resource["css"] for resource in book["resources"])
    assert all("position:absolute" not in resource["text"] for resource in book["resources"])


def test_publication_active_and_remote_content_is_isolated(tmp_path: Path) -> None:
    book = compile_fixture(tmp_path, malicious=True)
    resource = book["resources"][0]
    markup = resource["html"]
    for forbidden in ("<script", "<iframe", "onclick", "javascript:", "example.invalid", "../../"):
        assert forbidden not in markup
    assert "秘密" not in resource["text"]
    assert "安全な本文" in resource["text"]


@pytest.mark.parametrize("entry", ["../escape", "/absolute", "OEBPS/../../escape"])
def test_unsafe_zip_members_are_rejected(tmp_path: Path, entry: str) -> None:
    with pytest.raises(compiler.EpubError):
        compile_fixture(tmp_path, extra_entries={entry: b"bad"})


def test_fixed_layout_is_explicitly_rejected(tmp_path: Path) -> None:
    with pytest.raises(compiler.EpubError, match="[Ff]ixed"):
        compile_fixture(tmp_path, fixed=True)


def test_duplicate_zip_members_are_rejected(tmp_path: Path) -> None:
    path = tmp_path / "duplicate.epub"
    fixtures.build_fixture(path)
    with pytest.warns(UserWarning, match="Duplicate"):
        with ZipFile(path, "a") as archive:
            archive.writestr("OEBPS/chapter1.xhtml", "<html/>")
    with pytest.raises(compiler.EpubError):
        compiler.compile_epub(path)


def test_image_only_fixed_spine_page_in_reflowable_book(tmp_path: Path) -> None:
    path = tmp_path / "mixed.epub"
    fixtures.build_fixture(path)
    with ZipFile(path) as archive:
        entries = {name: archive.read(name) for name in archive.namelist()}
    entries["OEBPS/package.opf"] = entries["OEBPS/package.opf"].replace(
        b'<itemref idref="c1"/>',
        b'<itemref idref="c1" properties="rendition:layout-pre-paginated"/>',
    )
    entries["OEBPS/chapter1.xhtml"] = (
        b'<html xmlns="http://www.w3.org/1999/xhtml"><body>'
        b'<svg xmlns="http://www.w3.org/2000/svg">'
        b'<image xmlns:xlink="http://www.w3.org/1999/xlink" '
        b'xlink:href="images/pixel.png"/></svg></body></html>'
    )
    with ZipFile(path, "w") as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    book = compiler.compile_epub(path)
    assert book["resources"][0]["text"].strip() == ""
    assert "<img" in book["resources"][0]["html"]
    assert book["warnings"]


@pytest.mark.parametrize("encoding", ["utf-8", "utf-16-le", "utf-16-be"])
def test_entity_declarations_rejected_in_every_xml_encoding(encoding: str) -> None:
    declared = "UTF-8" if encoding == "utf-8" else "UTF-16"
    document = (
        f'<?xml version="1.0" encoding="{declared}"?>'
        '<!DOCTYPE html [<!ENTITY injected "ENTITY-MUST-NOT-EXPAND">]>'
        "<html><body><p>&injected;</p></body></html>"
    )
    bom = {"utf-8": b"", "utf-16-le": b"\xff\xfe", "utf-16-be": b"\xfe\xff"}[encoding]
    with pytest.raises(compiler.EpubError, match="entity declarations"):
        compiler.sanitize_xhtml(bom + document.encode(encoding), "chapter.xhtml", {})


def test_author_css_imports_and_document_attributes() -> None:
    warnings: list[str] = []
    files = {
        "styles/base.css": b'@import "nested.css"; .base { color: red; }',
        "styles/nested.css": b".vrtl { writing-mode: vertical-rl; }",
    }
    css = compiler._inline_css("@import url(base.css);", "styles/main.css", files, warnings)
    assert "writing-mode: vertical-rl" in css
    assert ".base" in css
    assert "@import" not in css
    assert warnings == []
    root = compiler._xml(b'<html class="vrtl" xml:lang="ja" dir="rtl" onclick="evil()"/>')
    assert compiler._presentation_attributes(root) == {"class": "vrtl", "lang": "ja", "dir": "rtl"}


def test_css_import_cycles_remote_and_unsupported_syntax_warn() -> None:
    warnings: list[str] = []
    css = compiler._inline_css(
        '@import "cycle.css"; @import "https://evil.test/style.css"; @import nonsense;',
        "styles/main.css",
        {"styles/cycle.css": b'@import "cycle.css";'},
        warnings,
    )
    assert "@import" not in css
    assert len(warnings) == 3


def test_legacy_cli_contract_remains_readable_by_experiment(tmp_path: Path) -> None:
    book = compile_fixture(tmp_path)
    assert book["contract"] == "epub-spike-v1"
    assert "materialVersion" in book
    assert "htmlAttributes" in book["resources"][0]
    assert "textSha256" in book["resources"][0]


def test_legacy_cli_missing_input_reports_friendly_error(tmp_path: Path) -> None:
    with pytest.raises(compiler.EpubError, match="无法读取 EPUB 文件"):
        compiler.compile_epub(tmp_path / "missing.epub")
