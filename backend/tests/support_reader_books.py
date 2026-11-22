import base64
import hashlib
from typing import Any

from support_epub import compiled

from app.epub_schemas import ChapterPart, CompiledBook, CompiledChapter


def bookmark_book(_raw: bytes) -> CompiledBook:
    book = compiled(b"")
    text = "前" * 100 + "😀𠮷が" + "後" * 200 + "外章"
    resource = book.resources[0].model_copy(
        update={"text": text, "text_sha256": hashlib.sha256(text.encode()).hexdigest()}
    )

    def part(start: int, end: int, markup: str, spine: int = 0) -> ChapterPart:
        return ChapterPart(
            resource_id="r1",
            spine_index=spine,
            start=start,
            end=end,
            html=markup,
            leaf_start=0,
            leaf_end=1,
        )

    return book.model_copy(
        update={
            "resources": [resource],
            "chapters": [
                CompiledChapter(
                    id="c1",
                    title="第一章",
                    level=0,
                    parts=[
                        part(0, 103, '<span data-locator-leaf="0">' + text[:103] + "</span>"),
                        part(
                            103,
                            303,
                            '<img data-epub-image="9" alt="一">'
                            '<span data-locator-leaf="1">後後後</span>'
                            '<img data-epub-image="2" alt="二">'
                            '<span data-locator-leaf="2">' + text[106:303] + "</span>",
                        ),
                    ],
                ),
                CompiledChapter(id="c2", title="外章", level=0, parts=[part(303, 305, "外章")]),
                CompiledChapter(
                    id="c3",
                    title="絵だけ",
                    level=0,
                    parts=[part(0, 0, '<img data-epub-image="0" alt="挿絵 &amp; 図">', 1)],
                ),
                CompiledChapter(
                    id="c4",
                    title="無名の絵",
                    level=0,
                    parts=[part(0, 0, '<img data-epub-image="0">', 2)],
                ),
            ],
        }
    )


def anchor(version: str = "version", **changes: Any) -> dict[str, Any]:
    return {
        "version_id": version,
        "chapter_id": "c1",
        "part_index": 0,
        "resource_id": "r1",
        "kind": "text",
        "offset": 100,
        **changes,
    }


PNG = b"\x89PNG\r\n\x1a\n" + b"synthetic-image"


def query_book(_raw: bytes) -> CompiledBook:
    book = compiled(b"")
    text = "😀𠮷é" + "あ" * 65 + "[.*]Ａ"
    encoded = base64.b64encode(PNG).decode()
    image = f'<img data-epub-image="0" alt="絵 &amp; 図" src="data:image/png;base64,{encoded}">'
    bad = '<img data-epub-image="1" src="data:image/png;base64,YmFk">'
    foreign = '<img data-epub-image="2" src="https://example.com/no.png">'
    svg = '<img data-epub-image="3" src="data:image/svg+xml;base64,PHN2Zz4=">'
    resource = book.resources[0].model_copy(
        update={
            "text": text,
            "html": image,
            "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
        }
    )

    def part(spine: int, start: int, end: int, html: str) -> ChapterPart:
        return ChapterPart(
            resource_id="r1",
            spine_index=spine,
            start=start,
            end=end,
            html=html,
            leaf_start=0,
            leaf_end=1,
        )

    return book.model_copy(
        update={
            "resources": [resource],
            "chapters": [
                CompiledChapter(
                    id="c1",
                    title="最初",
                    level=0,
                    parts=[
                        part(0, 0, 4, image),
                        part(0, 4, len(text), bad + foreign + svg),
                    ],
                ),
                CompiledChapter(
                    id="c2", title="繰返", level=0, parts=[part(1, 0, len(text), image)]
                ),
                CompiledChapter(id="c3", title="画像のみ", level=0, parts=[part(2, 0, 0, image)]),
            ],
        }
    )
