"""Bounded EPUB declared-cover extraction, without changing immutable book products."""

import asyncio
import io
import zipfile
import zlib

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.material_models import Material, MaterialCover
from app.services.epub import EpubError, package_tag, parse_package_xml, resolve_package_path
from app.services.materials import require_material
from app.services.sources import begin_write

MAX_COVER_BYTES = 4 * 1024 * 1024
MAX_METADATA_BYTES = 1024 * 1024


def valid_static_raster(data: bytes, media_type: str) -> bool:
    """Small header parser: static PNG/JPEG only, bounded decoded dimensions."""
    if media_type == "image/png":
        if not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) < 33:
            return False
        if data[8:16] != b"\x00\x00\x00\rIHDR":
            return False
        width = int.from_bytes(data[16:20], "big")
        height = int.from_bytes(data[20:24], "big")
        cursor = 8
        has_data = False
        while cursor + 12 <= len(data):
            size = int.from_bytes(data[cursor : cursor + 4], "big")
            kind = data[cursor + 4 : cursor + 8]
            end = cursor + 12 + size
            if end > len(data) or kind == b"acTL":
                return False
            checksum = int.from_bytes(data[end - 4 : end], "big")
            if zlib.crc32(data[cursor + 4 : end - 4]) != checksum:
                return False
            has_data = has_data or kind == b"IDAT"
            if kind == b"IEND":
                return (
                    size == 0 and end == len(data) and has_data and 0 < width * height <= 16_000_000
                )
            cursor = end
        return False
    if media_type == "image/jpeg":
        if not data.startswith(b"\xff\xd8") or not data.endswith(b"\xff\xd9"):
            return False
        cursor = 2
        dimensions_valid = False
        while cursor + 4 <= len(data):
            if data[cursor] != 255:
                return False
            marker = data[cursor + 1]
            if marker == 255:
                cursor += 1
                continue
            if marker == 0xDA:
                return dimensions_valid
            length = int.from_bytes(data[cursor + 2 : cursor + 4], "big")
            if length < 2 or cursor + 2 + length > len(data):
                return False
            if marker in {0xC0, 0xC1, 0xC2}:
                if length < 8:
                    return False
                height = int.from_bytes(data[cursor + 5 : cursor + 7], "big")
                width = int.from_bytes(data[cursor + 7 : cursor + 9], "big")
                dimensions_valid = 0 < width * height <= 16_000_000
            cursor += 2 + length
    return False


def extract_cover(raw: bytes) -> tuple[bytes, str] | None:
    """EPUB3 cover-image / EPUB2 meta name=cover; static raster only."""
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            infos = archive.infolist()
            if len(infos) > 5000 or sum(i.file_size for i in infos) > 128 * 1024 * 1024:
                return None
            names: set[str] = set()
            for info in infos:
                if (
                    info.filename in names
                    or info.filename.startswith("/")
                    or "\\" in info.filename
                    or ".." in info.filename.split("/")
                    or info.flag_bits & 1
                    or info.file_size > 16 * 1024 * 1024
                    or info.file_size / max(info.compress_size, 1) > 200
                ):
                    return None
                names.add(info.filename)
            if "META-INF/encryption.xml" in names:
                return None

            def read(path: str, limit: int) -> bytes:
                info = archive.getinfo(path)
                if info.file_size > limit:
                    raise EpubError("封面资源超过限制")
                return archive.read(info)

            container = parse_package_xml(read("META-INF/container.xml", MAX_METADATA_BYTES))
            package_path = resolve_package_path(
                "",
                next(
                    e.attrib["full-path"] for e in container.iter() if package_tag(e) == "rootfile"
                ),
            )
            package = parse_package_xml(read(package_path, MAX_METADATA_BYTES))
            cover_id = next(
                (
                    e.attrib.get("content")
                    for e in package.iter()
                    if package_tag(e) == "meta" and e.attrib.get("name") == "cover"
                ),
                None,
            )
            item = next(
                (
                    e
                    for e in package.iter()
                    if package_tag(e) == "item"
                    and (
                        "cover-image" in e.attrib.get("properties", "").split()
                        or (cover_id is not None and e.attrib.get("id") == cover_id)
                    )
                ),
                None,
            )
            if item is None:
                return None
            media_type = item.attrib.get("media-type", "")
            if media_type not in {"image/png", "image/jpeg"}:
                return None
            data = read(resolve_package_path(package_path, item.attrib["href"]), MAX_COVER_BYTES)
            valid = valid_static_raster(data, media_type)
            return (data, media_type) if valid else None
    except (
        EpubError,
        zipfile.BadZipFile,
        KeyError,
        StopIteration,
        OSError,
        ValueError,
        RuntimeError,
    ):
        return None


async def get_cover(session: AsyncSession, material_id: str) -> tuple[bytes, str]:
    await require_material(session, material_id, with_bundle=False)
    cached = await session.get(MaterialCover, material_id)
    if cached is None:
        raw = await session.scalar(
            select(Material.original_bytes).where(Material.id == material_id)
        )
        await session.rollback()
        extracted = await asyncio.to_thread(extract_cover, raw or b"")
        try:
            await begin_write(session)
            await require_material(session, material_id, with_bundle=False)
            cached = await session.get(MaterialCover, material_id)
            if cached is None:
                cached = MaterialCover(
                    material_id=material_id,
                    data=extracted[0] if extracted else None,
                    media_type=extracted[1] if extracted else None,
                )
                session.add(cached)
            await session.commit()
        except BaseException:
            await session.rollback()
            raise
    if cached.media_type is None:
        raise HTTPException(404, "没有可用封面")
    data = await session.scalar(
        select(MaterialCover.data).where(MaterialCover.material_id == material_id)
    )
    if data is None:
        raise HTTPException(404, "没有可用封面")
    return data, cached.media_type
