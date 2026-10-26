"""Production compiler chapter boundaries and immutable locator regressions."""

from __future__ import annotations

import hashlib
import html
import importlib.util
import io
import json
import unicodedata
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Literal
from zipfile import ZipFile, ZipInfo

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st
from pydantic import ValidationError

from app.epub_schemas import CompiledResource
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


def resource_markup(book: epub.CompiledBook, spine_index: int) -> str:
    return "".join(
        part.html
        for chapter in book.chapters
        for part in chapter.parts
        if part.spine_index == spine_index
    )


def assert_partition(book: epub.CompiledBook) -> None:
    for index, resource in enumerate(book.resources):
        parts = [
            part for chapter in book.chapters for part in chapter.parts if part.spine_index == index
        ]
        if not parts:
            assert resource.text == ""
            continue
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
        assert leaves == list(range(parts[-1].leaf_end))
        assert parts[0].leaf_start == 0
        assert all(a.leaf_end == b.leaf_start for a, b in zip(parts, parts[1:], strict=False))
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


def test_indexed_parts_keep_exact_markup_and_resource_offsets(tmp_path: Path) -> None:
    body = '<p>前<span id="split">が&amp;後</span></p>'
    nav = (
        '<li><a href="chapter1.xhtml">前</a></li>'
        '<li><a href="chapter1.xhtml#split">後</a></li>'
        '<li><a href="chapter2.xhtml">次</a></li>'
    )
    book = epub.compile_epub_bytes(publication(tmp_path, nav, body=body))
    first = book.chapters[0].parts[0]
    second = book.chapters[1].parts[0]
    assert (first.start, first.end, first.leaf_start, first.leaf_end) == (0, 1, 0, 1)
    assert (second.start, second.end, second.leaf_start, second.leaf_end) == (1, 5, 1, 3)
    assert first.html == '<p><span data-locator-leaf="0">前</span></p>'
    assert second.html == (
        '<p><span id="split"><span data-locator-leaf="1">が&amp;後</span></span></p>'
        '<span data-locator-leaf="2">\n</span>'
    )
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


@pytest.mark.parametrize("combining", [False, True])
def test_many_toc_entries_only_scan_and_normalize_resource_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, combining: bool
) -> None:
    count = 80
    text = "か<span>\u3099</span>" + "あ" * 198 if combining else "あ" * 200
    body = "".join(f'<p id="p{i}">{text}</p>' for i in range(count))
    nav = "".join(f'<li><a href="chapter1.xhtml#p{i}">{i}</a></li>' for i in range(count))
    normalize = unicodedata.normalize
    findall = epub.re.findall
    normalized_chars = 0
    scanned_chars = 0

    def counted_normalize(form: Literal["NFC", "NFD", "NFKC", "NFKD"], text: str) -> str:
        nonlocal normalized_chars
        normalized_chars += len(text)
        return normalize(form, text)

    def counted_findall(pattern: str, text: str, flags: int = 0) -> list[str]:
        nonlocal scanned_chars
        if "data-locator-leaf" in pattern:
            scanned_chars += len(text)
        return findall(pattern, text, flags)

    monkeypatch.setattr(unicodedata, "normalize", counted_normalize)
    monkeypatch.setattr(epub.re, "findall", counted_findall)
    book = epub.compile_epub_bytes(publication(tmp_path, nav, body=body))
    markup_size = sum(len(part.html) for chapter in book.chapters for part in chapter.parts)
    text_size = sum(len(resource.text) for resource in book.resources)
    assert scanned_chars <= markup_size, "at most one locator extraction per resource"
    assert normalized_chars <= 16 * text_size, "normalization work must not scale with TOC size"
    assert [chapter.title for chapter in book.chapters] == [str(i) for i in range(count)]
    assert_partition(book)


@pytest.mark.parametrize("leaf_count", [2, 80])
def test_sparse_toc_does_not_decompose_each_codepoint_of_non_nfc_resource(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, leaf_count: int
) -> None:
    body = (
        "<p>"
        + "".join(f'<span id="b{i}">{"a" * 1000}</span>' for i in range(leaf_count))
        + "か<span>\u3099後</span></p>"
    )
    nav = (
        '<li><a href="chapter1.xhtml">前</a></li>'
        f'<li><a href="chapter1.xhtml#b{leaf_count // 2}">後</a></li>'
        '<li><a href="chapter2.xhtml">次</a></li>'
    )
    normalize = unicodedata.normalize
    calls = 0

    def counted_normalize(form: Literal["NFC", "NFD", "NFKC", "NFKD"], text: str) -> str:
        nonlocal calls
        calls += 1
        return normalize(form, text)

    monkeypatch.setattr(unicodedata, "normalize", counted_normalize)
    book = epub.compile_epub_bytes(publication(tmp_path, nav, body=body))
    assert calls <= 20, "sparse requested boundaries must use a bounded number of stdlib passes"
    assert [chapter.title for chapter in book.chapters] == ["前", "後", "次"]
    assert_partition(book)


@pytest.mark.parametrize(
    "leaves",
    [
        ["ᄀ", "ᅡ", "ᆨ", "後"],
        ["\u0301", "\u0327", "a", "後"],
        ["a", "\u0315", "\u0300", "\u0327", "後"],
        ["á", "\u0327", "\u0301", "後"],
        ["\u0f73", "\u0f71", "後"],
        [*["a"] * 10, "ᄀ", "ᅡ", "ᆨ", "\u0315", "\u0300", "後"],
    ],
)
def test_leaf_boundaries_match_global_nfc_oracle(tmp_path: Path, leaves: list[str]) -> None:
    assert_leaf_boundary_oracle(tmp_path, leaves)


def assert_leaf_boundary_oracle(tmp_path: Path, leaves: list[str]) -> None:
    raw = "".join(leaves) + "\n"
    normalized = unicodedata.normalize("NFC", raw)
    body = (
        "<p>"
        + "".join(f'<span id="b{i}">{html.escape(value)}</span>' for i, value in enumerate(leaves))
        + "</p>"
    )
    nav = "".join(f'<li><a href="chapter1.xhtml#b{i}">{i}</a></li>' for i in range(len(leaves)))
    book = epub.compile_epub_bytes(publication(tmp_path, nav, body=body))
    starts: dict[str, int] = {}
    prefix = ""
    for index, value in enumerate(leaves):
        if (
            unicodedata.normalize("NFC", prefix) + unicodedata.normalize("NFC", raw[len(prefix) :])
            == normalized
        ):
            starts[str(index)] = len(unicodedata.normalize("NFC", prefix))
        prefix += value
    assert [chapter.title for chapter in book.chapters] == ["前置内容", *starts]
    assert [chapter.parts[0].start for chapter in book.chapters[1:]] == list(starts.values())
    assert_partition(book)


@settings(max_examples=60, deadline=None)
@given(
    st.lists(
        st.sampled_from(
            ["a", "か", "が", "ᄀ", "ᅡ", "ᆨ", "\u0300", "\u0315", "\u0327", "\u3099", "\u0f73", "&"]
        ),
        min_size=1,
        max_size=16,
    )
)
def test_generated_leaf_boundaries_match_global_nfc_oracle(leaves: list[str]) -> None:
    # A private temporary directory avoids Hypothesis fixture lifetime ambiguity.
    import tempfile

    with tempfile.TemporaryDirectory() as directory:
        assert_leaf_boundary_oracle(Path(directory), leaves)


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
    markup = resource_markup(book, 0)
    assert "<ruby>" in markup and "<rt>かんじ</rt>" in markup
    assert "かんじ" not in resource.text
    assert "data:image/png;base64," in markup
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
    markup = resource_markup(book, 0)
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
    assert "<img" in resource_markup(book, 0)
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


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("synthetic-reading", "014f87e7da839135a4f53e2d4d51d02048730b6da722be08f5102396803fdcbe"),
        ("synthetic-vertical", "5d5146ba1640d1cdbc3b49b79213af627e69c5b7730d41baf76701d582921a0e"),
        ("synthetic-malicious", "7137482b97a2b44b181c9a60595523c0ed8f87d16d68bb0d8bb052fa5dceba0e"),
    ],
)
def test_public_fixture_reading_snapshot_is_unchanged(name: str, expected: str) -> None:
    raw = (ROOT / "prototypes/epub-reading/fixtures" / f"{name}.epub").read_bytes()
    snapshot = epub.compile_epub_bytes(raw).model_dump(exclude={"contract", "product_sha256"})
    # Frozen against v1 before implementation: all reading data survives removal of resource HTML.
    for resource in snapshot["resources"]:
        resource.pop("html", None)
    compiled = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")).encode()
    assert hashlib.sha256(compiled).hexdigest() == expected


def test_archive_is_opened_once_and_each_member_read_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    raw = publication(tmp_path)
    opened = 0
    reads: dict[str, int] = {}

    class ObservedZip(ZipFile):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            nonlocal opened
            opened += 1
            super().__init__(*args, **kwargs)

        def read(self, name: str | ZipInfo, pwd: bytes | None = None) -> bytes:
            key = name.filename if isinstance(name, ZipInfo) else name
            reads[key] = reads.get(key, 0) + 1
            return super().read(name, pwd)

    monkeypatch.setattr(epub.zipfile, "ZipFile", ObservedZip)
    epub.compile_epub_bytes(raw)
    assert opened == 1
    assert reads and all(count == 1 for count in reads.values())


@pytest.mark.parametrize(
    "limit", ["entries", "expanded", "member", "ratio", "encrypted", "path", "duplicate", "drm"]
)
def test_archive_limits_reject_metadata_before_member_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, limit: str
) -> None:
    raw = publication(tmp_path)
    entries = [ZipInfo("safe.xhtml")]
    entries[0].file_size = 1
    entries[0].compress_size = 1
    if limit == "entries":
        entries *= 5001
    elif limit == "expanded":
        entries[0].file_size = 16 * 1024 * 1024
        entries[0].compress_size = entries[0].file_size
        entries *= 9
    elif limit == "member":
        entries[0].file_size = 16 * 1024 * 1024 + 1
        entries[0].compress_size = entries[0].file_size
    elif limit == "ratio":
        entries[0].file_size = 201
    elif limit == "encrypted":
        entries[0].flag_bits = 1
    elif limit == "path":
        entries[0].filename = "../escape"
    elif limit == "duplicate":
        entries *= 2
    else:
        entries[0].filename = "META-INF/encryption.xml"

    first = ZipInfo("first.xhtml")
    first.file_size = first.compress_size = 1
    entries.insert(0, first)

    def metadata(_archive: ZipFile) -> list[ZipInfo]:
        return entries

    def unexpected_read(*_args: Any, **_kwargs: Any) -> bytes:
        raise AssertionError("Unsafe ZIP metadata must be rejected before reading members")

    monkeypatch.setattr(ZipFile, "infolist", metadata)
    monkeypatch.setattr(ZipFile, "read", unexpected_read)
    with pytest.raises(epub.EpubError, match="limit|Encrypted|Unsafe|Duplicate"):
        epub.compile_epub_bytes(raw)


def test_compiled_contract_contains_only_chapter_html(tmp_path: Path) -> None:
    book = compile_fixture(tmp_path)
    assert book.contract == "epub-reading-v2"
    assert "html" not in CompiledResource.model_fields
    assert all("html" not in item for item in book.model_dump()["resources"])
    assert any(part.html for chapter in book.chapters for part in chapter.parts)


@pytest.mark.parametrize("markup", ["", "<p>redundant full resource HTML</p>"])
def test_compiled_resource_rejects_removed_html_field(tmp_path: Path, markup: str) -> None:
    resource = compile_fixture(tmp_path).resources[0].model_dump()
    resource["html"] = markup
    with pytest.raises(ValidationError, match="html"):
        CompiledResource.model_validate(resource)


@pytest.mark.parametrize("body", ["", "<p/>", '<div><span id="empty"/></div>'])
def test_empty_spine_bodies_keep_metadata_without_locator_text(tmp_path: Path, body: str) -> None:
    raw = publication(tmp_path, body=body)
    with ZipFile(io.BytesIO(raw)) as archive:
        files = {name: archive.read(name) for name in archive.namelist()}
    files["OEBPS/chapter2.xhtml"] = f"<html><body>{body}</body></html>".encode()
    output = io.BytesIO()
    with ZipFile(output, "w") as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    book = epub.compile_epub_bytes(output.getvalue())
    assert len(book.resources) == 2
    assert all(resource.text == "" for resource in book.resources)
    assert [chapter.id for chapter in book.chapters] == ["chapter-0", "chapter-1"]
    assert_partition(book)


def test_image_only_resource_retains_all_images_without_text(tmp_path: Path) -> None:
    body = '<div><img src="images/pixel.png"/><img src="images/pixel.png"/></div>'
    book = epub.compile_epub_bytes(publication(tmp_path, body=body))
    assert book.resources[0].text == ""
    markup = resource_markup(book, 0)
    assert markup.count("<img") == 2
    assert 'data-epub-image="0"' in markup
    assert 'data-epub-image="1"' in markup
    assert_partition(book)


def test_adjacent_image_toc_cuts_share_text_offset_and_keep_trailing_content(
    tmp_path: Path,
) -> None:
    body = (
        '<span>前</span><img id="one" src="images/pixel.png"/>'
        '<img id="two" src="images/pixel.png"/>'
        '<span id="tail">後</span><span id="last-empty"/>'
    )
    nav = (
        '<li><a href="chapter1.xhtml">前</a></li>'
        '<li><a href="chapter1.xhtml#one">絵一</a></li>'
        '<li><a href="chapter1.xhtml#two">絵二</a></li>'
        '<li><a href="chapter1.xhtml#tail">末尾</a></li>'
        '<li><a href="chapter2.xhtml">次</a></li>'
    )
    book = epub.compile_epub_bytes(publication(tmp_path, nav, body=body))
    assert [chapter.title for chapter in book.chapters] == ["前", "絵一", "絵二", "末尾", "次"]
    one, two, tail = (book.chapters[index].parts[0] for index in (1, 2, 3))
    assert one.start == one.end == two.start == two.end == tail.start == 1
    assert 'data-epub-image="0"' in one.html and 'data-epub-image="1"' not in one.html
    assert 'data-epub-image="1"' in two.html and 'data-epub-image="0"' not in two.html
    assert 'id="last-empty"' in tail.html
    assert LocatorText(tail.html).normalized() == book.resources[0].text[tail.start : tail.end]
    assert_partition(book)


def test_empty_markup_still_consumes_compilation_safety_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    raw = publication(tmp_path, body='<span class="empty"/>' * 1000)
    monkeypatch.setattr(epub, "MAX_PRODUCT_BYTES", 4000)
    with pytest.raises(epub.EpubError, match="安全大小限制"):
        epub.compile_epub_bytes(raw)


def test_sanitizer_preserves_source_markup_without_persisted_resource_html() -> None:
    source = (
        "<html><body><p>か<span>゙</span>&amp;<ruby>漢<rt>かん</rt></ruby></p>"
        '<script>秘密</script><iframe src="https://invalid.test"/></body></html>'
    ).encode()
    markup, text, _warnings = epub.sanitize_xhtml(source, "chapter.xhtml", {})
    assert text == "が&漢\n"
    assert '<span data-locator-leaf="0">か</span>' in markup
    assert "<rt>かん</rt>" in markup
    assert "<script" not in markup and "<iframe" not in markup
    assert "秘密" not in text and "かん" not in text
    assert LocatorText(markup).normalized() == text
