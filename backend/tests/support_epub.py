"""Synthetic EPUB publications and a minimal precompiled book."""

import hashlib
import io
from pathlib import Path
from zipfile import ZipFile

import make_epub_fixtures as fixtures

from app.epub_schemas import ChapterPart, CompiledBook, CompiledChapter, CompiledResource


def compiled(_data: bytes) -> CompiledBook:
    return CompiledBook(
        contract="test-v1",
        title="本",
        warnings=[],
        product_sha256="a" * 64,
        resources=[
            CompiledResource(
                id="r1",
                href="text.xhtml",
                title="章",
                text="日本語",
                css="",
                html_attributes={},
                body_attributes={},
                text_sha256=hashlib.sha256("日本語".encode()).hexdigest(),
            )
        ],
        chapters=[
            CompiledChapter(
                id="c1",
                title="章",
                level=0,
                parts=[
                    ChapterPart(
                        resource_id="r1",
                        spine_index=0,
                        start=0,
                        end=3,
                        html='<p>日本語</p><img data-epub-image="0">',
                        leaf_start=0,
                        leaf_end=1,
                    )
                ],
            )
        ],
    )


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
