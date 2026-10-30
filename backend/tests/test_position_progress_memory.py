"""Image progress must not retain a book's HTML outside ReaderViews' budget."""

import gc
import weakref

from test_materials import compiled

from app.material_schemas import PositionAnchor
from app.services.position_progress import chapter_progress


def test_image_progress_releases_large_html_after_projection() -> None:
    class Markup(str):
        pass

    markup = Markup(
        '<span data-locator-leaf="0">先頭</span>'
        '<img data-epub-image="1" src="data:image/png;base64,' + "a" * (1024 * 1024) + '">'
    )
    reference = weakref.ref(markup)
    book = compiled(b"")
    part = book.chapters[0].parts[0].model_copy(update={"html": markup, "end": 3})
    chapter = book.chapters[0].model_copy(update={"parts": [part]})
    book = book.model_copy(
        update={
            "chapters": [chapter],
            "resources": [book.resources[0].model_copy(update={"text": "先頭後"})],
        }
    )
    anchor = PositionAnchor(
        version_id="v",
        chapter_id=chapter.id,
        part_index=0,
        resource_id=part.resource_id,
        kind="image",
        image_id=1,
        image_progress=0,
    )
    assert chapter_progress(book, anchor) == 2 / 3
    del book, chapter, part, markup
    gc.collect()
    assert reference() is None
