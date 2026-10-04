"""Production compiler chapter boundaries and immutable locator regressions."""

from __future__ import annotations

import importlib.util
import io
import re
from pathlib import Path
from typing import Any
from zipfile import ZipFile

import pytest

from app.services import epub

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "epub_fixtures", ROOT / "scripts/make_epub_fixtures.py"
)
assert spec is not None and spec.loader is not None
fixtures: Any = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)


def publication(
    tmp_path: Path, nav: str | None = None, ncx: str | None = None, body: str | None = None
) -> bytes:
    path = tmp_path / "book.epub"
    fixtures.build_fixture(path)
    with ZipFile(path) as archive:
        files = {name: archive.read(name) for name in archive.namelist()}
    manifest = ""
    if nav is not None:
        manifest += (
            '<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>'
        )
        files["OEBPS/nav.xhtml"] = (
            '<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>'
            + nav
            + "</ol></nav></body></html>"
        ).encode()
    if ncx is not None:
        manifest += '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
        files["OEBPS/toc.ncx"] = ("<ncx><navMap>" + ncx + "</navMap></ncx>").encode()
    files["OEBPS/package.opf"] = files["OEBPS/package.opf"].replace(
        b"</manifest>", manifest.encode() + b"</manifest>"
    )
    if body is not None:
        files["OEBPS/chapter1.xhtml"] = ("<html><body>" + body + "</body></html>").encode()
    output = io.BytesIO()
    with ZipFile(output, "w") as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    return output.getvalue()


def assert_partition(book: epub.CompiledBook) -> None:
    for index, resource in enumerate(book.resources):
        parts = [
            part for chapter in book.chapters for part in chapter.parts if part.spine_index == index
        ]
        assert parts[0].start == 0 and parts[-1].end == len(resource.text)
        assert all(a.end == b.start for a, b in zip(parts, parts[1:], strict=False))
        assert "".join(resource.text[part.start : part.end] for part in parts) == resource.text
        leaves = [
            int(value)
            for part in parts
            for value in re.findall(r'data-locator-leaf="(\d+)"', part.html)
        ]
        assert leaves == list(range(parts[-1].leaf_end))


def test_nav_nested_fragments_no_lost_or_duplicate_content(tmp_path: Path) -> None:
    nav = '<li><a href="chapter1.xhtml"> 親 <ruby>章<rt>しょう</rt></ruby> </a><ol><li><a href="chapter1.xhtml#duplicate-two">子</a></li></ol></li><li><a href="chapter2.xhtml">終</a></li>'  # noqa: E501
    book = epub.compile_epub_bytes(publication(tmp_path, nav))
    assert [(chapter.title, chapter.level) for chapter in book.chapters] == [
        ("親 章", 0),
        ("子", 1),
        ("終", 0),
    ]
    assert "duplicate-two" not in book.chapters[0].parts[0].html
    assert "duplicate-two" in book.chapters[1].parts[0].html
    assert_partition(book)


def test_nav_precedes_ncx_and_diagnoses_invalid_reverse_duplicate(tmp_path: Path) -> None:
    nav = '<li><a href="chapter1.xhtml#duplicate-one">本文</a></li><li><a href="chapter1.xhtml#duplicate-one">重複</a></li><li><a href="chapter1.xhtml">逆順</a></li><li><a href="missing.xhtml">欠落</a></li><li><a href="chapter1.xhtml#missing">不存在</a></li>'  # noqa: E501
    ncx = (
        '<navPoint><navLabel><text>NCX</text></navLabel><content src="chapter2.xhtml"/></navPoint>'
    )
    book = epub.compile_epub_bytes(publication(tmp_path, nav, ncx))
    assert [chapter.title for chapter in book.chapters] == ["前置内容", "本文"]
    assert len(book.warnings) == 5
    assert len(book.chapters[1].parts) == 2
    assert_partition(book)


def test_ncx_hierarchy_and_missing_toc_fallback(tmp_path: Path) -> None:
    ncx = '<navPoint><navLabel><text>第一</text></navLabel><content src="chapter1.xhtml"/><navPoint><navLabel><text>第二</text></navLabel><content src="chapter2.xhtml"/></navPoint></navPoint>'  # noqa: E501
    book = epub.compile_epub_bytes(publication(tmp_path, ncx=ncx))
    assert [(chapter.title, chapter.level) for chapter in book.chapters] == [
        ("第一", 0),
        ("第二", 1),
    ]
    assert_partition(book)
    fallback = epub.compile_epub_bytes(publication(tmp_path))
    assert len(fallback.chapters) == 2 and fallback.warnings


def test_image_boundary_and_nfc_seam_are_not_lost(tmp_path: Path) -> None:
    body = '<p>か<span id="seam">\u3099</span></p><p id="picture"><img src="images/pixel.png"/></p>'
    nav = '<li><a href="chapter1.xhtml">文字</a></li><li><a href="chapter1.xhtml#seam">危険</a></li><li><a href="chapter1.xhtml#picture">絵</a></li><li><a href="chapter2.xhtml">次</a></li>'  # noqa: E501
    book = epub.compile_epub_bytes(publication(tmp_path, nav, body=body))
    assert [chapter.title for chapter in book.chapters] == ["文字", "絵", "次"]
    picture = book.chapters[1].parts[0]
    assert picture.start == picture.end and "<img" in picture.html
    assert 'data-epub-image="0"' in picture.html
    assert any("NFC" in warning for warning in book.warnings)
    assert_partition(book)


def test_output_budget_is_enforced_incrementally(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(epub, "MAX_PRODUCT_BYTES", 200)
    with pytest.raises(epub.EpubError, match="安全大小限制"):
        epub.compile_epub_bytes(publication(tmp_path))


def test_real_volume_eight_chapters_offline() -> None:
    path = ROOT / "temp/安達としまむら8.epub"
    if not path.exists():
        pytest.skip("只读样书未随仓库分发")
    book = epub.compile_epub_bytes(path.read_bytes())
    assert len(book.resources) == 24
    chapter = next(chapter for chapter in book.chapters if chapter.title == "『遠路』")
    assert [part.spine_index for part in chapter.parts] == [8, 9]
    assert_partition(book)
    assert book == epub.compile_epub_bytes(path.read_bytes())


def test_inline_image_budget_failure_cannot_be_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(epub, "MAX_PRODUCT_BYTES", 1000)
    with pytest.raises(epub.EpubError, match="安全大小限制"):
        epub.sanitize_xhtml(
            b'<html><body><img src="large.png"/></body></html>',
            "chapter.xhtml",
            {"large.png": b"x" * 1000},
        )


def test_duplicate_spine_occurrences_are_retained(tmp_path: Path) -> None:
    path = tmp_path / "repeat.epub"
    fixtures.build_fixture(path, duplicate_spine=True)
    book = epub.compile_epub_bytes(path.read_bytes())
    assert [part.spine_index for chapter in book.chapters for part in chapter.parts] == [0, 1, 2]
    assert book.resources[0].id == book.resources[2].id
    assert any("重复资源" in warning for warning in book.warnings)
    assert_partition(book)


def test_invalid_nav_targets_fall_back_to_valid_ncx(tmp_path: Path) -> None:
    nav = '<li><a href="missing.xhtml">欠落</a></li>'
    ncx = (
        "<navPoint><navLabel><text>NCX 原章名</text></navLabel>"
        '<content src="chapter1.xhtml"/></navPoint>'
    )
    book = epub.compile_epub_bytes(publication(tmp_path, nav, ncx))
    assert [chapter.title for chapter in book.chapters] == ["NCX 原章名"]
    assert any("nav 目录没有有效正文目标" in warning for warning in book.warnings)
    assert_partition(book)


def test_same_document_fragment_nav_target_on_spine(tmp_path: Path) -> None:
    data = publication(tmp_path, '<li><a href="#part">原章名</a></li>')
    with ZipFile(io.BytesIO(data)) as archive:
        files = {name: archive.read(name) for name in archive.namelist()}
    files["OEBPS/package.opf"] = files["OEBPS/package.opf"].replace(
        b"<spine>", b'<spine><itemref idref="nav"/>'
    )
    files["OEBPS/nav.xhtml"] = files["OEBPS/nav.xhtml"].replace(
        b"</body>", '<p id="part">同文档正文</p></body>'.encode()
    )
    output = io.BytesIO()
    with ZipFile(output, "w") as archive:
        for name, payload in files.items():
            archive.writestr(name, payload)
    book = epub.compile_epub_bytes(output.getvalue())
    assert [chapter.title for chapter in book.chapters] == ["前置内容", "原章名"]
    assert book.chapters[1].parts[0].spine_index == 0
    assert "同文档正文" in book.chapters[1].parts[0].html
    assert_partition(book)
