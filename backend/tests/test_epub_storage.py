"""Lossless versioned compiled-book storage and decoding safety contracts."""

import base64
import hashlib
import json
import random
import zlib
from pathlib import Path
from typing import Any

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app import epub_storage
from app.epub_schemas import ChapterPart, CompiledBook, CompiledChapter, CompiledResource
from app.services.epub import compile_epub_bytes

MAGIC = b"FJEPUB\x02"


def make_book(image: bytes | None = None, *, title: str = "が・日本語𠮷📚") -> CompiledBook:
    text = "が\n日本語𠮷📚\n"
    marker = 'literal: {"image":0} __EPUB_IMAGE_0__ ["image",0]'
    picture = (
        f'<img data-epub-image="0" src="data:image/png;base64,'
        f'{base64.b64encode(image).decode()}" alt="{marker}">'
        if image is not None
        else ""
    )
    fragment = (
        '<p><span data-locator-leaf="0">か</span>'
        '<span data-locator-leaf="1">\u3099</span></p>'
        f'<p><ruby><span data-locator-leaf="2">日本語𠮷📚</span>'
        f"<rt>にほんご</rt><rp>（</rp></ruby>{picture}</p>"
    )
    resource = CompiledResource(
        id="resource-0",
        href="OEBPS/日本語.xhtml",
        title=title,
        text=text,
        css='p::before { content: "__EPUB_IMAGE_0__"; }',
        html_attributes={"lang": "ja"},
        body_attributes={"class": "vertical"},
        text_sha256=hashlib.sha256(text.encode()).hexdigest(),
    )
    return CompiledBook(
        contract="epub-reading-v2",
        title=title,
        warnings=[marker],
        resources=[resource, resource.model_copy()],
        chapters=[
            CompiledChapter(
                id=f"chapter-{index}",
                title=f"章{index}",
                level=index,
                parts=[
                    ChapterPart(
                        resource_id=resource.id,
                        spine_index=index,
                        start=0,
                        end=len(text),
                        html=fragment,
                        leaf_start=0,
                        leaf_end=3,
                    )
                ],
            )
            for index in range(2)
        ],
        product_sha256="a" * 64,
    )


def legacy_payload(book: CompiledBook) -> bytes:
    return zlib.compress(book.model_dump_json().encode())


def large_image() -> bytes:
    # Seeded high-entropy bytes exceed DEFLATE's window; global pooling must do the work.
    return b"\x89PNG\r\n\x1a\n" + random.Random(20261025).randbytes(64 * 1024)


def _pooled_envelope() -> tuple[bytes, dict[str, Any]]:
    payload = epub_storage.encode(make_book(large_image()))
    assert payload.startswith(MAGIC), "Large repeated images must use the pooled format"
    return payload, json.loads(zlib.decompress(payload[len(MAGIC) :]))


def _pack_envelope(envelope: dict[str, Any]) -> bytes:
    return MAGIC + zlib.compress(json.dumps(envelope, ensure_ascii=False).encode())


def test_complete_logical_book_roundtrips_without_mutating_the_input() -> None:
    book = make_book(large_image())
    before = book.model_dump_json()

    encoded = epub_storage.encode(book)
    restored = epub_storage.decode(encoded)

    assert restored.model_dump_json() == before
    assert book.model_dump_json() == before
    assert restored.chapters[1].parts[0].spine_index == 1
    assert restored.resources[0].text == "が\n日本語𠮷📚\n"
    assert 'data-locator-leaf="1">\u3099' in restored.chapters[0].parts[0].html
    assert restored.product_sha256 == book.product_sha256


@pytest.mark.parametrize("compressed", [False, True])
def test_unversioned_json_is_rejected(compressed: bool) -> None:
    book = make_book(b"small image")
    payload = legacy_payload(book) if compressed else book.model_dump_json().encode()
    with pytest.raises(ValueError):
        epub_storage.decode(payload)


@pytest.mark.parametrize("fixture", ["reading", "vertical", "malicious"])
def test_real_compiler_outputs_keep_their_exact_logical_snapshot(fixture: str) -> None:
    root = Path(__file__).resolve().parents[2]
    path = root / "prototypes" / "epub-reading" / "fixtures" / f"synthetic-{fixture}.epub"
    book = compile_epub_bytes(path.read_bytes())
    before = book.model_dump_json()
    assert epub_storage.decode(epub_storage.encode(book)).model_dump_json() == before
    assert book.model_dump_json() == before


def test_repeated_large_image_is_stored_once_instead_of_deflate_window_repetition() -> None:
    book = make_book(large_image())
    encoded = epub_storage.encode(book)
    envelope = json.loads(zlib.decompress(encoded[len(MAGIC) :]))
    assert len(envelope["images"]) == 1
    assert all(0 in chapter[0] for chapter in envelope["chapter_html"])
    assert len(encoded) < len(legacy_payload(book)) * 0.6
    assert epub_storage.decode(encoded).model_dump_json() == book.model_dump_json()


@pytest.mark.parametrize("image", [None, b"x", b"\x89PNG\r\n\x1a\n"])
def test_books_without_profitable_pooling_still_use_the_versioned_format(
    image: bytes | None,
) -> None:
    book = make_book(image)
    encoded = epub_storage.encode(book)
    assert encoded.startswith(MAGIC)
    assert epub_storage.decode(encoded).model_dump_json() == book.model_dump_json()


def test_truncated_or_trailing_compressed_data_is_rejected() -> None:
    book = make_book(large_image())
    payload = epub_storage.encode(book)
    for damaged in (payload[:-1], payload[: len(payload) // 2], payload + b"garbage"):
        with pytest.raises(ValueError):
            epub_storage.decode(damaged)


@pytest.mark.parametrize(
    "payload",
    [
        b"",
        b"not compressed",
        zlib.compress(b"null"),
        MAGIC + zlib.compress(b"null"),
        MAGIC + zlib.compress(b"{}"),
        MAGIC + b"not compressed",
    ],
)
def test_invalid_input_raises_value_error(payload: bytes) -> None:
    with pytest.raises(ValueError):
        epub_storage.decode(payload)


def test_unknown_storage_version_is_rejected() -> None:
    payload, _ = _pooled_envelope()
    with pytest.raises(ValueError):
        epub_storage.decode(b"FJEPUB\xff" + payload[len(MAGIC) :])


@pytest.mark.parametrize("reference", [-1, True, False, 0.0, 0.5, None, {}, [], 1000000])
def test_invalid_pooled_references_are_rejected(reference: object) -> None:
    _, envelope = _pooled_envelope()
    envelope["chapter_html"][0][0] = [reference]
    with pytest.raises(ValueError):
        epub_storage.decode(_pack_envelope(envelope))


@pytest.mark.parametrize(
    "damage",
    [
        "resource_html",
        "empty_resource_html_field",
        "missing_chapter",
        "extra_part",
        "nonempty_resource_html",
        "empty_removed_resource_html",
        "nonempty_part_html",
        "nonstring_image",
        "nonimage_uri",
        "invalid_base64",
    ],
)
def test_malformed_storage_envelopes_are_rejected(damage: str) -> None:
    _, envelope = _pooled_envelope()
    if damage == "resource_html":
        envelope["resource_html"] = [["hidden resource HTML"]]
    elif damage == "empty_resource_html_field":
        envelope["resource_html"] = []
    elif damage == "missing_chapter":
        envelope["chapter_html"].pop()
    elif damage == "extra_part":
        envelope["chapter_html"][0].append([])
    elif damage in {"nonempty_resource_html", "empty_removed_resource_html"}:
        envelope["book"]["resources"][0]["html"] = (
            "hidden content" if damage == "nonempty_resource_html" else ""
        )
    elif damage == "nonempty_part_html":
        envelope["book"]["chapters"][0]["parts"][0]["html"] = "hidden content"
    elif damage == "nonstring_image":
        envelope["images"][0] = 123
    elif damage == "nonimage_uri":
        envelope["images"][0] = "https://external.invalid/image.png"
    else:
        envelope["images"][0] = "data:image/png;base64,???"
    with pytest.raises(ValueError):
        epub_storage.decode(_pack_envelope(envelope))


def test_pooled_decompression_budget_is_enforced(monkeypatch: pytest.MonkeyPatch) -> None:
    payload, _ = _pooled_envelope()
    monkeypatch.setattr(epub_storage, "MAX_PRODUCT_BYTES", 64)
    with pytest.raises(ValueError):
        epub_storage.decode(payload)


def test_restored_json_budget_counts_repeated_image_references(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload, _ = _pooled_envelope()
    envelope_bytes = zlib.decompress(payload[len(MAGIC) :])
    assert len(envelope_bytes) < len(make_book(large_image()).model_dump_json().encode())
    monkeypatch.setattr(epub_storage, "MAX_PRODUCT_BYTES", len(envelope_bytes) + 1)
    with pytest.raises(ValueError):
        epub_storage.decode(payload)


def test_encoding_rejects_a_book_over_the_logical_product_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(epub_storage, "MAX_PRODUCT_BYTES", 64)
    with pytest.raises(ValueError):
        epub_storage.encode(make_book())


@pytest.mark.parametrize("image_size", ["none", "small", "large"])
def test_encoding_compresses_once_and_always_writes_the_versioned_format(
    image_size: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    image = None if image_size == "none" else b"x" if image_size == "small" else large_image()
    book = make_book(image)
    original_compress = zlib.compress
    compressed_sizes: list[int] = []

    def record_compress(data: bytes) -> bytes:
        compressed_sizes.append(len(data))
        return original_compress(data)

    monkeypatch.setattr(zlib, "compress", record_compress)
    encoded = epub_storage.encode(book)
    assert len(compressed_sizes) == 1
    assert encoded.startswith(MAGIC)
    assert epub_storage.decode(encoded).model_dump_json() == book.model_dump_json()


def test_valid_near_limit_book_has_room_for_storage_envelope_overhead(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    book = make_book().model_copy(
        update={"title": "日本語" * 300, "resources": [], "chapters": [], "warnings": []}
    )
    logical_size = len(book.model_dump_json().encode())
    monkeypatch.setattr(epub_storage, "MAX_PRODUCT_BYTES", logical_size)
    encoded = epub_storage.encode(book)
    assert encoded.startswith(MAGIC)
    envelope_size = len(zlib.decompress(encoded[len(MAGIC) :]))
    assert logical_size < envelope_size <= logical_size * 2
    assert epub_storage.decode(encoded).model_dump_json() == book.model_dump_json()


@pytest.mark.parametrize("empty_resources", [False, True])
def test_oversized_metadata_is_rejected_even_without_html_to_restore(
    empty_resources: bool, monkeypatch: pytest.MonkeyPatch
) -> None:
    book = make_book().model_copy(update={"title": "文" * 3000})
    if empty_resources:
        book = book.model_copy(update={"resources": [], "chapters": []})
    else:
        book = book.model_copy(
            update={
                "chapters": [
                    c.model_copy(
                        update={"parts": [p.model_copy(update={"html": ""}) for p in c.parts]}
                    )
                    for c in book.chapters
                ],
            }
        )
    payload = epub_storage.encode(book)
    monkeypatch.setattr(epub_storage, "MAX_PRODUCT_BYTES", len(book.model_dump_json().encode()) - 1)
    with pytest.raises(ValueError):
        epub_storage.decode(payload)
    with pytest.raises(ValueError):
        epub_storage.encode(book)


@settings(max_examples=20, deadline=None)
@given(st.text(alphabet=st.characters(blacklist_categories=("Cs",)), max_size=50))
def test_arbitrary_unicode_and_marker_text_is_never_interpreted_as_a_reference(title: str) -> None:
    book = make_book(large_image(), title=title)
    assert (
        epub_storage.decode(epub_storage.encode(book)).model_dump_json() == book.model_dump_json()
    )


def test_new_storage_has_only_chapter_html_and_rejects_old_version() -> None:
    root = Path(__file__).resolve().parents[2]
    book = compile_epub_bytes(
        (root / "prototypes/epub-reading/fixtures/synthetic-reading.epub").read_bytes()
    )
    payload = epub_storage.encode(book)
    assert payload.startswith(b"FJEPUB\x02")
    envelope = json.loads(zlib.decompress(payload[7:]))
    assert "resource_html" not in envelope
    assert all("html" not in item for item in envelope["book"]["resources"])
    assert envelope["chapter_html"]
    with pytest.raises(ValueError):
        epub_storage.decode(b"FJEPUB\x01" + payload[7:])
