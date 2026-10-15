"""Generate deterministic, original synthetic EPUBs for the isolated reading spike."""

# XML fixtures intentionally keep individual source tags intact.
from __future__ import annotations

import argparse
from pathlib import Path
from zipfile import ZIP_STORED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]
CHAPTER_ONE = (
    '<h1>第一章</h1><p id="ruby-line"><ruby>漢字<rp>（</rp><rt>かんじ</rt><rp>）</rp></ruby> &amp; 本。</p>'
    '<p id="duplicate-one">同じ言葉。</p><p id="duplicate-two">同じ言葉。</p>'
    '<p id="unicode"><span>か</span><em>\u3099</em>と𠮷、👩\u200d💻。</p>'
    '<p id="lines">前<br/>後</p><p>Ａ①</p><p><img src="images/pixel.png" alt="挿絵"/></p>'
)
CHAPTER_TWO = "<h1>第二章</h1><p>次の章でも<ruby>日本語<rt>にほんご</rt></ruby>を読む。</p><blockquote><p>引用の文章。</p></blockquote>"
# A one-pixel PNG, generated fixture data rather than a publication asset.
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082"
)


def build_fixture(
    path: Path,
    *,
    vertical: bool = False,
    malicious: bool = False,
    fixed: bool = False,
    duplicate_spine: bool = False,
    extra_entries: dict[str, bytes] | None = None,
) -> None:
    """Write an EPUB without timestamps or randomness, suitable for byte identity tests."""
    metadata = '<meta property="rendition:layout">pre-paginated</meta>' if fixed else ""
    spine = '<itemref idref="c1"/><itemref idref="c2"/>'
    if duplicate_spine:
        spine += '<itemref idref="c1"/>'
    attack = (
        (
            '<script>parent.__epubAttack=true</script><iframe src="https://example.invalid/"/>'
            '<p onclick="alert(1)">安全な本文<span hidden="hidden">秘密</span></p>'
            '<img src="https://example.invalid/tracker"/><img src="../../etc/passwd"/>'
            '<a href="javascript:alert(1)">リンク</a><style>body{background:url(https://example.invalid/x)}</style>'
        )
        if malicious
        else ""
    )

    def document(title: str, body: str) -> bytes:
        return (
            f'<html xmlns="http://www.w3.org/1999/xhtml"><head><title>{title}</title>'
            f'<link rel="stylesheet" href="styles/book.css"/></head><body>{body}</body></html>'
        ).encode()

    entries = {
        "mimetype": b"application/epub+zip",
        "META-INF/container.xml": b'<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        "OEBPS/package.opf": (
            f'<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:folio-j:synthetic</dc:identifier><dc:title>日語定位合成樣書</dc:title><dc:language>ja</dc:language>{metadata}</metadata><manifest><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/><item id="css" href="styles/book.css" media-type="text/css"/><item id="image" href="images/pixel.png" media-type="image/png"/></manifest><spine>{spine}</spine></package>'
        ).encode(),
        "OEBPS/chapter1.xhtml": document("第一章", CHAPTER_ONE + attack),
        "OEBPS/chapter2.xhtml": document("第二章", CHAPTER_TWO),
        "OEBPS/styles/book.css": (
            ".special{position:absolute;width:800px} body{writing-mode:vertical-rl}"
            if vertical
            else "body{font-size:1em}"
        ).encode(),
        "OEBPS/images/pixel.png": PNG,
    }
    entries.update(extra_entries or {})
    path.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(path, "w") as archive:
        for name, data in entries.items():
            info = ZipInfo(name, (2020, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_STORED
            archive.writestr(info, data)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", type=Path, default=ROOT / "prototypes/epub-reading/fixtures"
    )
    args = parser.parse_args()
    build_fixture(args.output / "synthetic-reading.epub")
    build_fixture(args.output / "synthetic-vertical.epub", vertical=True)
    build_fixture(args.output / "synthetic-malicious.epub", malicious=True)
    build_fixture(args.output / "synthetic-fixed.epub", fixed=True)


if __name__ == "__main__":
    main()
