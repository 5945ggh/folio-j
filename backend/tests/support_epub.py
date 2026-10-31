"""Minimal compiled EPUB for tests that replace the import compiler."""

import hashlib

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
