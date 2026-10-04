"""Bounded EPUB declared-cover extraction, without changing immutable book products."""

import asyncio
import io
import zipfile
import zlib
from dataclasses import dataclass
from xml.etree import ElementTree as ET

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.material_models import Material, MaterialCover
from app.services.epub import EpubError, package_tag, parse_package_xml, resolve_package_path
from app.services.materials import require_material
from app.services.sources import begin_write

COVER_RULE_VERSION = 2
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
        if not data.startswith(b"\xff\xd8"):
            return False
        cursor = 2
        dimensions_valid = False
        has_scan = False
        in_scan = False
        scan_has_entropy = False
        components: set[int] = set()
        while cursor < len(data):
            if in_scan:
                marker_start = data.find(b"\xff", cursor)
                if marker_start < 0:
                    return False
                scan_has_entropy = scan_has_entropy or marker_start > cursor
                cursor = marker_start
            if data[cursor] != 255:
                return False
            while cursor < len(data) and data[cursor] == 255:
                cursor += 1
            if cursor >= len(data):
                return False
            marker = data[cursor]
            cursor += 1
            if in_scan and (marker == 0 or 0xD0 <= marker <= 0xD7):
                scan_has_entropy = scan_has_entropy or marker == 0
                continue
            if in_scan and not scan_has_entropy:
                return False
            in_scan = False
            if marker == 0xD9:
                # Some publishers append padding/signature bytes after the EOI marker.
                return dimensions_valid and has_scan and len(data) - cursor <= 1024
            if marker in {0, 0xD8} or 0xD0 <= marker <= 0xD7:
                return False
            if cursor + 2 > len(data):
                return False
            length = int.from_bytes(data[cursor : cursor + 2], "big")
            if length < 2 or cursor + length > len(data):
                return False
            if marker in {0xC0, 0xC1, 0xC2}:
                if length < 8:
                    return False
                count = data[cursor + 7]
                if count == 0 or length != 8 + 3 * count:
                    return False
                components = {data[cursor + 8 + 3 * i] for i in range(count)}
                if len(components) != count:
                    return False
                height = int.from_bytes(data[cursor + 3 : cursor + 5], "big")
                width = int.from_bytes(data[cursor + 5 : cursor + 7], "big")
                dimensions_valid = 0 < width * height <= 16_000_000
                if not dimensions_valid:
                    return False
            if marker == 0xDA:
                if length < 6 or not dimensions_valid:
                    return False
                count = data[cursor + 2]
                if count == 0 or length != 6 + 2 * count:
                    return False
                scan_components = {data[cursor + 3 + 2 * i] for i in range(count)}
                if len(scan_components) != count or not scan_components.issubset(components):
                    return False
                has_scan = True
                in_scan = True
                scan_has_entropy = False
            cursor += length
    return False


@dataclass(frozen=True)
class CoverExtraction:
    cover: tuple[bytes, str] | None
    reason: str


def inspect_cover(raw: bytes) -> CoverExtraction:
    """Declared raster, then spine references, then manifest order; all bounded/local."""
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            infos = archive.infolist()
            if len(infos) > 5000 or sum(i.file_size for i in infos) > 128 * 1024 * 1024:
                return CoverExtraction(None, "unsafe_archive")
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
                    return CoverExtraction(None, "unsafe_archive")
                names.add(info.filename)
            if "META-INF/encryption.xml" in names:
                return CoverExtraction(None, "unsafe_archive")

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
            items = [e for e in package.iter() if package_tag(e) == "item"]
            by_id = {e.attrib.get("id"): e for e in items}
            by_path: dict[str, ET.Element] = {}
            for item in items:
                try:
                    by_path[resolve_package_path(package_path, item.attrib.get("href", ""))] = item
                except EpubError:
                    continue
            cover_ids = {
                e.attrib.get("content")
                for e in package.iter()
                if package_tag(e) == "meta" and e.attrib.get("name") == "cover"
            }
            seen: set[str] = set()
            failures: list[str] = []

            def candidate(path: str, media_type: str, origin: str) -> CoverExtraction | None:
                if path in seen:
                    return None
                seen.add(path)
                if media_type not in {"image/png", "image/jpeg"}:
                    failures.append("unsupported_format")
                    return None
                try:
                    data = read(path, MAX_COVER_BYTES)
                except (KeyError, EpubError, OSError, ValueError, RuntimeError):
                    failures.append("missing_or_oversized_resource")
                    return None
                if not valid_static_raster(data, media_type):
                    failures.append("invalid_raster")
                    return None
                reason = origin
                if failures:
                    reason += "; skipped=" + ",".join(dict.fromkeys(failures))
                return CoverExtraction((data, media_type), reason)

            for item in items:
                if (
                    "cover-image" in item.attrib.get("properties", "").split()
                    or item.attrib.get("id") in cover_ids
                ):
                    try:
                        path = resolve_package_path(package_path, item.attrib.get("href", ""))
                    except EpubError:
                        failures.append("unsafe_reference")
                        continue
                    result = candidate(path, item.attrib.get("media-type", ""), "declared")
                    if result:
                        return result
            read_documents: set[str] = set()
            for ref in package.iter():
                if package_tag(ref) != "itemref":
                    continue
                document = by_id.get(ref.attrib.get("idref"))
                if document is None:
                    continue
                try:
                    path = resolve_package_path(package_path, document.attrib.get("href", ""))
                    if path in read_documents:
                        continue
                    read_documents.add(path)
                    content = parse_package_xml(read(path, MAX_METADATA_BYTES))
                except (EpubError, KeyError, OSError, ValueError, RuntimeError):
                    failures.append("invalid_spine_document")
                    continue
                for element in content.iter():
                    tag = package_tag(element)
                    href = (
                        element.attrib.get("src")
                        if tag == "img"
                        else (
                            element.attrib.get("href")
                            or element.attrib.get("{http://www.w3.org/1999/xlink}href")
                            if tag == "image"
                            else None
                        )
                    )
                    if not href:
                        continue
                    try:
                        image_path = resolve_package_path(path, href)
                    except EpubError:
                        failures.append("unsafe_reference")
                        continue
                    image = by_path.get(image_path)
                    if image is None:
                        failures.append("unlisted_image")
                        continue
                    result = candidate(image_path, image.attrib.get("media-type", ""), "spine")
                    if result:
                        return result
            for item in items:
                if not item.attrib.get("media-type", "").startswith("image/"):
                    continue
                try:
                    path = resolve_package_path(package_path, item.attrib.get("href", ""))
                except EpubError:
                    failures.append("unsafe_reference")
                    continue
                result = candidate(path, item.attrib.get("media-type", ""), "manifest")
                if result:
                    return result
            return CoverExtraction(
                None, "no_images" if not failures else ",".join(dict.fromkeys(failures))
            )
    except (
        EpubError,
        zipfile.BadZipFile,
        KeyError,
        StopIteration,
        OSError,
        ValueError,
        RuntimeError,
    ):
        return CoverExtraction(None, "invalid_package")


def extract_cover(raw: bytes) -> tuple[bytes, str] | None:
    return inspect_cover(raw).cover


async def get_cover(session: AsyncSession, material_id: str) -> tuple[bytes, str]:
    await require_material(session, material_id, with_bundle=False)
    cached = await session.get(MaterialCover, material_id)
    if cached is None or cached.rule_version != COVER_RULE_VERSION:
        raw = await session.scalar(
            select(Material.original_bytes).where(Material.id == material_id)
        )
        await session.rollback()
        result = await asyncio.to_thread(inspect_cover, raw or b"")
        extracted = result.cover
        try:
            await begin_write(session)
            await require_material(session, material_id, with_bundle=False)
            cached = await session.get(MaterialCover, material_id)
            if cached is None or cached.rule_version != COVER_RULE_VERSION:
                if cached is None:
                    cached = MaterialCover(material_id=material_id)
                    session.add(cached)
                cached.data = extracted[0] if extracted else None
                cached.media_type = extracted[1] if extracted else None
                cached.rule_version = COVER_RULE_VERSION
                cached.diagnostic_reason = result.reason
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
