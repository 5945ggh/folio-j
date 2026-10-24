"""Production compiler chapter boundaries and immutable locator regressions."""

from __future__ import annotations

import html
import importlib.util
import io
import json
import unicodedata
from html.parser import HTMLParser
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


class LocatorText(HTMLParser):
    """Read rendered locator text independently of the compiler's regex projection."""

    def __init__(self, markup: str) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[bool, bool]] = []
        self.leaves: list[int] = []
        self.text: list[str] = []
        self.feed(markup)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"img", "br", "hr"}:
            return
        locator, annotation = self.stack[-1] if self.stack else (False, False)
        annotation = annotation or tag in {"rt", "rp"}
        marker = dict(attrs).get("data-locator-leaf")
        if marker is not None:
            assert not annotation, "ruby annotation must not contribute locator text"
            self.leaves.append(int(marker))
        self.stack.append((locator or marker is not None, annotation))

    def handle_endtag(self, tag: str) -> None:
        if tag not in {"img", "br", "hr"}:
            self.stack.pop()

    def handle_data(self, data: str) -> None:
        if self.stack and self.stack[-1] == (True, False):
            self.text.append(data)

    def normalized(self) -> str:
        return unicodedata.normalize("NFC", "".join(self.text))


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
        rendered = LocatorText(resource.html)
        assert rendered.normalized() == resource.text
        parts = [
            part for chapter in book.chapters for part in chapter.parts if part.spine_index == index
        ]
        assert parts[0].start == 0 and parts[-1].end == len(resource.text)
        assert all(a.end == b.start for a, b in zip(parts, parts[1:], strict=False))
        assert "".join(resource.text[part.start : part.end] for part in parts) == resource.text
        leaves: list[int] = []
        raw_text: list[str] = []
        for part in parts:
            projection = LocatorText(part.html)
            assert projection.normalized() == resource.text[part.start : part.end]
            assert projection.leaves == list(range(part.leaf_start, part.leaf_end))
            leaves.extend(projection.leaves)
            raw_text.extend(projection.text)
        assert leaves == rendered.leaves == list(range(len(rendered.leaves)))
        assert unicodedata.normalize("NFC", "".join(raw_text)) == resource.text


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
    for title in ("重複", "逆順"):
        assert any(f"目录目标重复或逆序，已跳过：{title}" in warning for warning in book.warnings)
    for title in ("欠落", "不存在"):
        assert any(f"目录目标缺失或无效，已跳过：{title}" in warning for warning in book.warnings)
    assert any("前置内容" in warning for warning in book.warnings)
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


@pytest.mark.parametrize(
    "field", ["book-title", "resource-title", "chapter-title", "attributes", "warnings"]
)
def test_complete_product_budget_counts_metadata_and_json_escaping(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, field: str
) -> None:
    # Quotes/backslashes expand in JSON; non-ASCII metadata remains UTF-8.
    label = '章"\\' * 2500
    nav = (
        f'<li><a href="chapter1.xhtml">{html.escape(label)}</a></li>'
        if field == "chapter-title"
        else None
    )
    raw = publication(tmp_path, nav=nav, body="<p>本文</p>")
    with ZipFile(io.BytesIO(raw)) as archive:
        files = {name: archive.read(name) for name in archive.namelist()}
    if field == "book-title":
        files["OEBPS/package.opf"] = (
            files["OEBPS/package.opf"]
            .replace(b"</metadata>", f"<title>{html.escape(label)}</title></metadata>".encode())
            .replace(b"<dc:title>", b"<other>")
            .replace(b"</dc:title>", b"</other>")
        )
    elif field == "resource-title":
        files["OEBPS/chapter1.xhtml"] = (
            f"<html><head><title>{html.escape(label)}</title></head><body><p>本文</p></body></html>"
        ).encode()
    elif field == "attributes":
        files["OEBPS/chapter1.xhtml"] = (
            f'<html class="{html.escape(label, quote=True)}"><body><p>本文</p></body></html>'
        ).encode()
    elif field == "warnings":
        files["OEBPS/nav.xhtml"] = (
            '<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>'
            f'<li><a href="missing.xhtml">{html.escape(label)}</a></li>'
            "</ol></nav></body></html>"
        ).encode()
        files["OEBPS/package.opf"] = files["OEBPS/package.opf"].replace(
            b"</manifest>",
            b'<item id="nav" href="nav.xhtml" properties="nav" '
            b'media-type="application/xhtml+xml"/></manifest>',
        )
    output = io.BytesIO()
    with ZipFile(output, "w") as archive:
        for name, payload in files.items():
            archive.writestr(name, payload)
    monkeypatch.setattr(epub, "MAX_PRODUCT_BYTES", 12000)
    with pytest.raises(epub.EpubError, match="安全大小限制"):
        epub.compile_epub_bytes(output.getvalue())


def test_product_budget_stops_before_building_all_repeated_titles(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    raw = publication(tmp_path, body="<p>本文</p>")
    with ZipFile(io.BytesIO(raw)) as archive:
        files = {name: archive.read(name) for name in archive.namelist()}
    files["OEBPS/chapter1.xhtml"] = (
        "<html><head><title>" + "t" * 3000 + "</title></head><body><p>本文</p></body></html>"
    ).encode()
    files["OEBPS/package.opf"] = files["OEBPS/package.opf"].replace(
        b'<itemref idref="c1"/>', b'<itemref idref="c1"/>' * 30
    )
    output = io.BytesIO()
    with ZipFile(output, "w") as archive:
        for name, payload in files.items():
            archive.writestr(name, payload)
    monkeypatch.setattr(epub, "MAX_PRODUCT_BYTES", 12000)
    calls = 0
    sanitize = epub.sanitize_xhtml

    def counted(*args: Any, **kwargs: Any) -> tuple[str, str, list[str]]:
        nonlocal calls
        calls += 1
        return sanitize(*args, **kwargs)

    monkeypatch.setattr(epub, "sanitize_xhtml", counted)
    with pytest.raises(epub.EpubError, match="安全大小限制"):
        epub.compile_epub_bytes(output.getvalue())
    assert calls < 10, "reject during resource construction, before all copies or final JSON"


def test_json_budget_matches_complete_compiled_product(tmp_path: Path) -> None:
    book = epub.compile_epub_bytes(publication(tmp_path, body='<p title="&quot;">が\\\t本</p>'))
    budget = [0]
    epub._spend_json(budget, book.model_dump())  # pyright: ignore[reportPrivateUsage]
    assert budget[0] == len(book.model_dump_json().encode())
    metadata: dict[str, object] = {"quoted": '"\\\n\x00章' * 1000, "empty": [], "number": 42}
    budget = [0]
    epub._spend_json(budget, metadata)  # pyright: ignore[reportPrivateUsage]
    encoded = json.dumps(metadata, ensure_ascii=False, separators=(",", ":")).encode()
    assert budget[0] == len(encoded)


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


def compile_fixture(tmp_path: Path, **kwargs: Any) -> epub.CompiledBook:
    path = tmp_path / "sample.epub"
    fixtures.build_fixture(path, **kwargs)
    return epub.compile_epub_bytes(path.read_bytes())


def test_projection_keeps_base_entities_blocks_and_global_nfc(tmp_path: Path) -> None:
    book = compile_fixture(tmp_path)
    resource = book.resources[0]
    assert resource.text == (
        "第一章\n漢字 & 本。\n同じ言葉。\n同じ言葉。\nがと𠮷、👩\u200d💻。\n前\n後\nＡ①\n"
    )
    assert "<ruby>" in resource.html and "<rt>かんじ</rt>" in resource.html
    assert "かんじ" not in resource.text
    assert "data:image/png;base64," in resource.html
    # NFKC is deliberately not used; fullwidth/compatibility source characters survive.
    assert "Ａ①" in resource.text


def test_output_and_fixture_bytes_are_deterministic(tmp_path: Path) -> None:
    first, second = tmp_path / "a.epub", tmp_path / "b.epub"
    fixtures.build_fixture(first)
    fixtures.build_fixture(second)
    assert first.read_bytes() == second.read_bytes()
    assert epub.compile_epub_bytes(first.read_bytes()) == epub.compile_epub_bytes(
        second.read_bytes()
    )
    original = epub.compile_epub_bytes(first.read_bytes()).product_sha256
    fixtures.build_fixture(second, vertical=True)
    assert epub.compile_epub_bytes(second.read_bytes()).product_sha256 != original


def test_author_styles_do_not_enter_projection(tmp_path: Path) -> None:
    book = compile_fixture(tmp_path, vertical=True)
    assert all("position:absolute" in resource.css for resource in book.resources)
    assert all("position:absolute" not in resource.text for resource in book.resources)


def test_publication_active_and_remote_content_is_isolated(tmp_path: Path) -> None:
    book = compile_fixture(tmp_path, malicious=True)
    resource = book.resources[0]
    markup = resource.html
    for forbidden in ("<script", "<iframe", "onclick", "javascript:", "example.invalid", "../../"):
        assert forbidden not in markup
    assert "秘密" not in resource.text
    assert "安全な本文" in resource.text


@pytest.mark.parametrize("entry", ["../escape", "/absolute", "OEBPS/../../escape"])
def test_unsafe_zip_members_are_rejected(tmp_path: Path, entry: str) -> None:
    with pytest.raises(epub.EpubError):
        compile_fixture(tmp_path, extra_entries={entry: b"bad"})


def test_fixed_layout_is_explicitly_rejected(tmp_path: Path) -> None:
    with pytest.raises(epub.EpubError, match="[Ff]ixed"):
        compile_fixture(tmp_path, fixed=True)


def test_duplicate_zip_members_are_rejected(tmp_path: Path) -> None:
    path = tmp_path / "duplicate.epub"
    fixtures.build_fixture(path)
    with pytest.warns(UserWarning, match="Duplicate"):
        with ZipFile(path, "a") as archive:
            archive.writestr("OEBPS/chapter1.xhtml", "<html/>")
    with pytest.raises(epub.EpubError):
        epub.compile_epub_bytes(path.read_bytes())


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
    book = epub.compile_epub_bytes(path.read_bytes())
    assert book.resources[0].text.strip() == ""
    assert "<img" in book.resources[0].html
    assert book.warnings


@pytest.mark.parametrize("encoding", ["utf-8", "utf-16-le", "utf-16-be"])
def test_entity_declarations_rejected_in_every_xml_encoding(encoding: str) -> None:
    declared = "UTF-8" if encoding == "utf-8" else "UTF-16"
    document = (
        f'<?xml version="1.0" encoding="{declared}"?>'
        '<!DOCTYPE html [<!ENTITY injected "ENTITY-MUST-NOT-EXPAND">]>'
        "<html><body><p>&injected;</p></body></html>"
    )
    bom = {"utf-8": b"", "utf-16-le": b"\xff\xfe", "utf-16-be": b"\xfe\xff"}[encoding]
    with pytest.raises(epub.EpubError, match="entity declarations"):
        epub.sanitize_xhtml(bom + document.encode(encoding), "chapter.xhtml", {})


def test_author_css_imports_and_document_attributes() -> None:
    warnings: list[str] = []
    files = {
        "styles/base.css": b'@import "nested.css"; .base { color: red; }',
        "styles/nested.css": b".vrtl { writing-mode: vertical-rl; }",
    }
    css = epub.inline_css("@import url(base.css);", "styles/main.css", files, warnings)
    assert "writing-mode: vertical-rl" in css
    assert ".base" in css
    assert "@import" not in css
    assert warnings == []
    root = epub.parse_xml(b'<html class="vrtl" xml:lang="ja" dir="rtl" onclick="evil()"/>')
    assert epub.presentation_attributes(root) == {"class": "vrtl", "lang": "ja", "dir": "rtl"}


def test_css_import_cycles_remote_and_unsupported_syntax_warn() -> None:
    warnings: list[str] = []
    css = epub.inline_css(
        '@import "cycle.css"; @import "https://evil.test/style.css"; @import nonsense;',
        "styles/main.css",
        {"styles/cycle.css": b'@import "cycle.css";'},
        warnings,
    )
    assert "@import" not in css
    assert any("cycle or depth limit" in warning for warning in warnings)
    assert any("External package resource is unsupported" in warning for warning in warnings)
    assert any("Unsupported CSS import syntax" in warning for warning in warnings)
    assert css.strip() == ""
