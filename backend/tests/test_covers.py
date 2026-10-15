"""Declared cover extraction stays bounded, local and rebuildable."""

import base64
import io
import zipfile
from pathlib import Path

import pytest
from test_materials import compiled
from test_source_segment import api_client

from app.services.covers import extract_cover

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def cover_book(
    *,
    href: str = "cover.png",
    data: bytes = PNG,
    media_type: str = "image/png",
    epub2: bool = False,
    extra: dict[str, bytes] | None = None,
) -> bytes:
    memory = io.BytesIO()
    metadata = '<meta name="cover" content="cover" />' if epub2 else ""
    properties = "" if epub2 else ' properties="cover-image"'
    package = (
        f"<package><metadata>{metadata}</metadata><manifest>"
        f'<item id="cover" href="{href}" media-type="{media_type}"{properties}/>'
        "</manifest></package>"
    )
    files = {
        "META-INF/container.xml": (
            b'<container><rootfiles><rootfile full-path="book/package.opf"/>'
            b"</rootfiles></container>"
        ),
        "book/package.opf": package.encode(),
        "book/cover.png": data,
        **(extra or {}),
    }
    with zipfile.ZipFile(memory, "w") as archive:
        for path, value in files.items():
            archive.writestr(path, value)
    return memory.getvalue()


@pytest.mark.parametrize("epub2", [False, True])
def test_declared_cover(epub2: bool) -> None:
    assert extract_cover(cover_book(epub2=epub2)) == (PNG, "image/png")


@pytest.mark.parametrize(
    "kwargs",
    [
        {"href": "https://example.invalid/cover.png"},
        {"href": "../../../outside.png"},
        {"href": "cover.svg", "media_type": "image/svg+xml"},
        {"data": b"<svg>not a raster</svg>"},
        {"data": PNG + b"x" * (4 * 1024 * 1024)},
        {"extra": {"../escape": b"x"}},
        {"extra": {"META-INF/encryption.xml": b"x"}},
    ],
)
def test_cover_fallback(kwargs: dict[str, object]) -> None:
    assert extract_cover(cover_book(**kwargs)) is None  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_cached_cover_preserves_product_and_deleted_gate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import sqlite3

    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    database = tmp_path / "covers.db"
    async with api_client(database) as client:
        source = (await client.post("/api/sources", json={"title": "封面"})).json()["id"]
        result = await client.post(
            f"/api/sources/{source}/materials",
            content=cover_book(),
            headers={"content-type": "application/epub+zip"},
        )
        material = result.json()["material"]
        url = "/api/materials/" + material["id"]

        def snapshot() -> tuple[object, ...]:
            with sqlite3.connect(database) as connection:
                row = connection.execute(
                    "SELECT original_bytes,compiled_bundle,version_id FROM materials WHERE id=?",
                    (material["id"],),
                ).fetchone()
                assert row is not None
                return row

        before = snapshot()
        response = await client.get(url + "/cover")
        assert response.status_code == 200 and response.content == PNG
        assert response.headers["content-type"] == "image/png"
        assert response.headers["cache-control"] == "no-store"

        def reject(_raw: bytes) -> None:
            raise AssertionError("cache must not re-extract")

        monkeypatch.setattr("app.services.covers.inspect_cover", reject)
        assert (await client.get(url + "/cover")).content == PNG
        assert snapshot() == before
        assert (await client.delete("/api/sources/" + source)).status_code == 204
        assert (await client.get(url + "/cover")).status_code == 404


@pytest.mark.asyncio
async def test_failed_cover_is_cached_and_catalog_uses_placeholder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    async with api_client(tmp_path / "fallback.db") as client:
        source = (await client.post("/api/sources", json={"title": "占位"})).json()["id"]
        imported = (
            await client.post(
                f"/api/sources/{source}/materials",
                content=b"no-cover",
                headers={"content-type": "application/epub+zip"},
            )
        ).json()["material"]
        url = "/api/materials/" + imported["id"] + "/cover"
        assert (await client.get(url)).status_code == 404

        def reject(_raw: bytes) -> None:
            raise AssertionError("negative cache must not re-extract")

        monkeypatch.setattr("app.services.covers.inspect_cover", reject)
        assert (await client.get(url)).status_code == 404
        assert (await client.get("/api/materials")).json()["items"][0]["cover_url"] is None


def test_corrupt_crc_animation_and_large_dimensions_fall_back() -> None:
    import zlib

    from app.services.covers import valid_static_raster

    corrupt = bytearray(PNG)
    corrupt[29] ^= 1
    assert not valid_static_raster(bytes(corrupt), "image/png")
    animated = PNG[:33] + b"\x00\x00\x00\x08acTL" + b"\x00" * 12 + PNG[33:]
    assert not valid_static_raster(animated, "image/png")
    huge = bytearray(PNG)
    huge[16:24] = (100_000).to_bytes(4, "big") * 2
    huge[29:33] = zlib.crc32(huge[12:29]).to_bytes(4, "big")
    assert not valid_static_raster(bytes(huge), "image/png")
    entity = cover_book(
        extra={
            "META-INF/container.xml": b'<!DOCTYPE container [<!ENTITY x "book/package.opf">]>'
            b"<container>"
            b'<rootfile full-path="&x;"/></container>'
        }
    )
    assert extract_cover(entity) is None


def jpeg_fixture() -> bytes:
    """Original synthetic baseline JPEG marker stream, with one bounded scan."""
    return bytes.fromhex(
        "ffd8ffc00011080001000103011100021100031100ffda000c03010002000300003f001122ffd9"
    )


def test_jpeg_with_trailing_bytes_is_usable() -> None:
    from app.services.covers import valid_static_raster

    assert valid_static_raster(jpeg_fixture() + b"\x00", "image/jpeg")
    assert not valid_static_raster(jpeg_fixture()[:-2], "image/jpeg")


def fallback_book(*, declared: str = "", first: bytes = PNG) -> bytes:
    return cover_book(
        extra={
            "book/package.opf": (
                "<package><manifest>"
                + declared
                + '<item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>'
                '<item id="other" href="other.jpg" media-type="image/jpeg"/>'
                '<item id="first" href="first.png" media-type="image/png"/>'
                '</manifest><spine><itemref idref="chapter"/></spine></package>'
            ).encode(),
            "book/chapter.xhtml": (
                b'<html><body><img src="first.png"/><img src="other.jpg"/></body></html>'
            ),
            "book/first.png": first,
            "book/other.jpg": jpeg_fixture(),
        }
    )


def test_spine_image_precedes_manifest_order() -> None:
    assert extract_cover(fallback_book()) == (PNG, "image/png")


def test_bad_declaration_and_bad_first_image_continue() -> None:
    declaration = (
        '<item id="bad" href="missing.png" media-type="image/png" properties="cover-image"/>'
    )
    assert extract_cover(fallback_book(declared=declaration)) == (PNG, "image/png")
    assert extract_cover(fallback_book(first=b"broken")) == (jpeg_fixture(), "image/jpeg")
    from app.services.covers import inspect_cover

    assert inspect_cover(fallback_book(first=b"broken")).reason == "spine; skipped=invalid_raster"


@pytest.mark.asyncio
@pytest.mark.parametrize("successful", [False, True])
async def test_old_cache_rebuilds_without_touching_book(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, successful: bool
) -> None:
    import sqlite3

    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    database = tmp_path / "old.db"
    async with api_client(database) as client:
        source = (await client.post("/api/sources", json={"title": "旧缓存"})).json()["id"]
        imported = (
            await client.post(
                f"/api/sources/{source}/materials",
                content=fallback_book(),
                headers={"content-type": "application/epub+zip"},
            )
        ).json()["material"]
        material_id = imported["id"]
        with sqlite3.connect(database) as connection:
            before = connection.execute(
                "SELECT original_bytes,compiled_bundle,version_id FROM materials WHERE id=?",
                (material_id,),
            ).fetchone()
            connection.execute(
                "INSERT INTO material_covers VALUES (?,?,?,?,?)",
                (
                    material_id,
                    "image/jpeg" if successful else None,
                    jpeg_fixture() if successful else None,
                    1,
                    "legacy_cache",
                ),
            )
        item = (await client.get("/api/materials")).json()["items"][0]
        assert item["cover_url"].endswith("?v=2")
        response = await client.get(item["cover_url"])
        assert response.status_code == 200 and response.content == PNG
        with sqlite3.connect(database) as connection:
            assert (
                connection.execute(
                    "SELECT original_bytes,compiled_bundle,version_id FROM materials WHERE id=?",
                    (material_id,),
                ).fetchone()
                == before
            )
            assert connection.execute(
                "SELECT rule_version,diagnostic_reason FROM material_covers WHERE material_id=?",
                (material_id,),
            ).fetchone() == (2, "spine")


def test_no_images_and_candidate_limits_have_diagnostics() -> None:
    from app.services.covers import inspect_cover

    no_images = cover_book(extra={"book/package.opf": b"<package><manifest/><spine/></package>"})
    assert inspect_cover(no_images).reason == "no_images"
    result = inspect_cover(fallback_book(first=PNG + b"x" * (4 * 1024 * 1024)))
    assert result.cover == (jpeg_fixture(), "image/jpeg")
    assert inspect_cover(cover_book(extra={"../escape": b"x"})).reason == "unsafe_archive"


def test_jpeg_scan_structure_and_tail_are_bounded() -> None:
    from app.services.covers import valid_static_raster

    jpeg = jpeg_fixture()
    assert not valid_static_raster(jpeg + b"x" * 1025, "image/jpeg")
    assert not valid_static_raster(
        jpeg.replace(b"\xff\xda\x00\x0c", b"\xff\xda\xff\xff"), "image/jpeg"
    )
    assert valid_static_raster(jpeg[:-2] + b"\xff\x00\xff\xd0\xff\xd9", "image/jpeg")


@pytest.mark.parametrize(
    "bad",
    [
        bytes.fromhex("ffd8ffc00008080001000100ffda000600000000ffd9"),
        jpeg_fixture().replace(b"\x11\x22\xff\xd9", b"\xff\xd9"),
        jpeg_fixture().replace(b"\xff\xda\x00\x0c\x03\x01", b"\xff\xda\x00\x0c\x03\x04"),
    ],
)
def test_malformed_jpeg_declaration_falls_back_to_good_spine_image(bad: bytes) -> None:
    from app.services.covers import valid_static_raster

    assert not valid_static_raster(bad, "image/jpeg")
    declaration = (
        '<item id="other" href="other.jpg" media-type="image/jpeg" properties="cover-image"/>'
    )
    raw = fallback_book(declared=declaration)
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        files = {name: archive.read(name) for name in archive.namelist()}
    files["book/other.jpg"] = bad
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for name, value in files.items():
            archive.writestr(name, value)
    assert extract_cover(output.getvalue()) == (PNG, "image/png")
