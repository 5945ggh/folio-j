"""Isolated stdlib EPUB → controlled reading JSON experiment (not production ingest)."""

from __future__ import annotations

import base64
import hashlib
import html
import io
import json
import posixpath
import re
import unicodedata
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, cast
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET
from xml.parsers import expat

from app.epub_schemas import ChapterPart, CompiledBook, CompiledChapter, CompiledResource

CONTRACT = "epub-reading-v1"
MAX_PRODUCT_BYTES = 64 * 1024 * 1024
RULES = (
    "xml-xhtml;allowlist-v1;block-end-newline;raw-leaves-global-NFC;rt-rp-excluded;"
    "isolated-fixed-raster-v1;css-import-v1;document-attributes-v1;toc-ranges-v1"
)

ALLOWED = frozenset(
    [
        "div",
        "p",
        "span",
        "section",
        "article",
        "aside",
        "header",
        "footer",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "blockquote",
        "pre",
        "code",
        "em",
        "strong",
        "b",
        "i",
        "u",
        "s",
        "small",
        "sub",
        "sup",
        "ruby",
        "rb",
        "rt",
        "rp",
        "br",
        "hr",
        "ul",
        "ol",
        "li",
        "dl",
        "dt",
        "dd",
        "table",
        "thead",
        "tbody",
        "tfoot",
        "tr",
        "th",
        "td",
        "caption",
        "figure",
        "figcaption",
        "img",
        "a",
    ]
)
BLOCKS = frozenset(
    [
        "div",
        "p",
        "section",
        "article",
        "aside",
        "header",
        "footer",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "blockquote",
        "pre",
        "ul",
        "ol",
        "li",
        "dl",
        "dt",
        "dd",
        "table",
        "tr",
        "figure",
        "figcaption",
    ]
)
DROP = frozenset(
    [
        "script",
        "style",
        "iframe",
        "object",
        "embed",
        "form",
        "input",
        "button",
        "textarea",
        "select",
        "option",
        "audio",
        "video",
        "canvas",
        "svg",
        "math",
        "template",
    ]
)
IMAGE_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}


class EpubError(ValueError):
    """Unsupported or unsafe experimental input."""


class EpubLimitError(EpubError):
    """Safety limit failures cannot be downgraded to optional-resource warnings."""


def _spend(budget: list[int], amount: int) -> None:
    budget[0] += amount
    if budget[0] > MAX_PRODUCT_BYTES:
        raise EpubLimitError("编译产物超过安全大小限制")


def _label(element: ET.Element) -> str:
    def text(node: ET.Element) -> str:
        if _tag(node) in {"rt", "rp"}:
            return ""
        return (node.text or "") + "".join(text(child) + (child.tail or "") for child in node)

    return unicodedata.normalize("NFC", " ".join(text(element).split()))


def _tag(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1].lower()


def _xml(data: bytes) -> ET.Element:
    def reject_entity(*_arguments: object) -> None:
        raise EpubError("XML entity declarations are unsupported")

    # Expat detects declarations after decoding the document's declared encoding.
    # Reject before ElementTree can expand any internal entities.
    parser = expat.ParserCreate()
    depth = [0]

    def start_element(_name: str, _attributes: dict[str, str]) -> None:
        depth[0] += 1
        if depth[0] > 128:
            raise EpubError("XML 嵌套过深，无法安全读取")

    def end_element(_name: str) -> None:
        depth[0] -= 1

    parser.StartElementHandler = start_element
    parser.EndElementHandler = end_element
    parser.EntityDeclHandler = reject_entity
    try:
        parser.Parse(data, True)
        return ET.fromstring(data)
    except (ET.ParseError, expat.ExpatError) as exc:
        raise EpubError(f"Only well-formed XML XHTML is supported: {exc}") from exc


def _resolve(base: str, target: str) -> str:
    parts = urlsplit(target)
    if parts.scheme or parts.netloc or parts.query:
        raise EpubError(f"External package resource is unsupported: {target}")
    decoded = unquote(parts.path)
    if not decoded:
        return base
    if "\\" in decoded or decoded.startswith("/"):
        raise EpubError(f"Unsafe package path: {target}")
    path = posixpath.normpath(posixpath.join(posixpath.dirname(base), decoded))
    if path == ".." or path.startswith("../"):
        raise EpubError(f"Package path escapes archive: {target}")
    return path


def sanitize_xhtml(
    data: bytes, href: str, package_files: dict[str, bytes], budget: list[int] | None = None
) -> tuple[str, str, list[str]]:
    """Return sanitized fragment, globally NFC locator text, and warnings.

    Locator leaves retain original text. Blocks append one explicit newline if
    the preceding locator leaf does not already end with one; br always adds one.
    rt/rp remain visible but contain no locator leaves. CSS never defines text.
    """
    budget = budget if budget is not None else [0]
    root = _xml(data)
    body = next((el for el in root.iter() if _tag(el) == "body"), root)
    leaves: list[str] = []
    image_count = [0]
    warnings: list[str] = []

    def leaf(value: str | None, annotation: bool = False) -> str:
        if not value:
            return ""
        _spend(budget, len(value.encode()) * 6 + 80)
        value = value.replace("\r\n", "\n").replace("\r", "\n")
        if annotation:
            return html.escape(value)
        index = len(leaves)
        leaves.append(value)
        return f'<span data-locator-leaf="{index}">{html.escape(value)}</span>'

    def render(node: ET.Element, annotation: bool = False) -> str:
        tag = _tag(node)
        _spend(budget, 80 + sum(len(value.encode()) * 6 for value in node.attrib.values()))
        # A common EPUB cover is SVG used only as a raster-image wrapper.
        # Convert that exact shape; never expose executable SVG to the reader.
        if (
            tag == "svg"
            and len(node) == 1
            and _tag(node[0]) == "image"
            and "hidden" not in node.attrib
            and node.attrib.get("aria-hidden", "").lower() != "true"
        ):
            image_node = node[0]
            source = image_node.attrib.get("href") or image_node.attrib.get(
                "{http://www.w3.org/1999/xlink}href", ""
            )
            return render(ET.Element("img", {"src": source}), annotation)
        if (
            tag in DROP
            or "hidden" in node.attrib
            or node.attrib.get("aria-hidden", "").lower() == "true"
        ):
            return ""
        annotation = annotation or tag in {"rt", "rp"}
        if tag == "br":
            return leaf("\n", annotation)
        attrs: list[str] = []
        for key in ("id", "class", "lang", "dir", "title", "colspan", "rowspan"):
            if key in node.attrib:
                attrs.append(f' {key}="{html.escape(node.attrib[key], quote=True)}"')
        if tag == "img":
            attrs.append(f' data-epub-image="{image_count[0]}"')
            image_count[0] += 1
            try:
                path = _resolve(href, node.attrib.get("src", ""))
                mime = IMAGE_TYPES.get(Path(path).suffix.lower())
                payload = package_files.get(path)
                if not mime or payload is None:
                    raise EpubError("Unsupported or missing image")
                _spend(budget, (len(payload) + 2) // 3 * 4)
                attrs.append(f' src="data:{mime};base64,{base64.b64encode(payload).decode()}"')
                attrs.append(f' alt="{html.escape(node.attrib.get("alt", ""), quote=True)}"')
            except EpubLimitError:
                raise
            except EpubError:
                warnings.append(f"Removed unsupported image in {href}")
                return ""
        # Author URLs and inline styles are never copied into the fragment.
        inside = leaf(node.text, annotation)
        for child in node:
            inside += render(child, annotation) + leaf(child.tail, annotation)
        if tag not in ALLOWED:
            return inside
        if tag in {"img", "hr"}:
            output = f"<{tag}{''.join(attrs)}>"
        else:
            output = f"<{tag}{''.join(attrs)}>{inside}</{tag}>"
        if tag in BLOCKS and not annotation and leaves and not leaves[-1].endswith("\n"):
            output += leaf("\n")
        return output

    fragment = leaf(body.text)
    for child in body:
        fragment += render(child) + leaf(child.tail)
    return fragment, unicodedata.normalize("NFC", "".join(leaves)), warnings


def _presentation_attributes(element: ET.Element) -> dict[str, str]:
    attributes = {
        key: element.attrib[key] for key in ("class", "dir", "lang") if key in element.attrib
    }
    if "lang" not in attributes and "{http://www.w3.org/XML/1998/namespace}lang" in element.attrib:
        attributes["lang"] = element.attrib["{http://www.w3.org/XML/1998/namespace}lang"]
    return attributes


def _inline_css(
    css: str,
    href: str,
    files: dict[str, bytes],
    warnings: list[str],
    stack: tuple[str, ...] = (),
    budget: list[int] | None = None,
) -> str:
    """Expand a deliberately small CSS import grammar; never silently omit imports."""
    if budget is None:
        budget = [0]
    budget[0] += len(css.encode())
    if budget[0] > 4 * 1024 * 1024:
        raise EpubError("CSS import expansion exceeds size limit")
    # Comments cannot contain active imports. Keep author rules, discard comments.
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.DOTALL)
    pattern = re.compile(r"@import\s+([^;]*);", re.IGNORECASE)

    def expand(match: re.Match[str]) -> str:
        statement = match.group(1).strip()
        parsed = re.fullmatch(
            r"(?:[\"]([^\"]+)[\"]|[']([^']+)[']|url\(\s*(?:[\"]([^\"]+)[\"]|[']([^']+)[']|([^\s\)'\"]+))\s*\))\s*(.*)",
            statement,
            flags=re.IGNORECASE,
        )
        if parsed is None:
            warnings.append(f"Unsupported CSS import syntax in {href}: {statement}")
            return ""
        target = next(value for value in parsed.groups()[:5] if value is not None)
        media = parsed.group(6).strip()
        if media and not re.fullmatch(r"[a-zA-Z0-9 ,():.\-]+", media):
            warnings.append(f"Unsupported CSS import condition in {href}: {media}")
            return ""
        try:
            imported_path = _resolve(href, target)
            if imported_path in stack or len(stack) >= 8:
                raise EpubError("CSS import cycle or depth limit")
            imported = files[imported_path].decode("utf-8-sig")
            expanded = _inline_css(
                imported,
                imported_path,
                files,
                warnings,
                (*stack, imported_path),
                budget,
            )
            return f"@media {media} {{\n{expanded}\n}}" if media else expanded
        except (EpubError, KeyError, UnicodeError) as exc:
            warnings.append(f"Skipped CSS import in {href}: {target} ({exc})")
            return ""

    expanded = pattern.sub(expand, css)
    if re.search(r"@import\b", expanded, re.IGNORECASE):
        warnings.append(f"Unterminated CSS import removed in {href}")
        expanded = re.sub(r"@import\b.*", "", expanded, flags=re.IGNORECASE | re.DOTALL)
    if len(expanded.encode()) > 4 * 1024 * 1024:
        raise EpubError("Expanded CSS exceeds size limit")
    return expanded


def _compile_legacy(path: Path | io.BytesIO) -> dict[str, object]:
    """Compile a reflowable, unencrypted EPUB without extracting ZIP entries."""
    files: dict[str, bytes] = {}
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            if len(infos) > 5000 or sum(info.file_size for info in infos) > 128 * 1024 * 1024:
                raise EpubError("Archive exceeds entry count or expanded size limit")
            for info in infos:
                name = info.filename
                if name.startswith("/") or "\\" in name or ".." in name.split("/"):
                    raise EpubError(f"Unsafe ZIP entry: {name}")
                if info.flag_bits & 1:
                    raise EpubError("Encrypted ZIP/DRM is unsupported")
                if (
                    info.file_size > 16 * 1024 * 1024
                    or info.file_size / max(info.compress_size, 1) > 200
                ):
                    raise EpubError("Archive member exceeds expansion limits")
                if not info.is_dir():
                    if name in files:
                        raise EpubError(f"Duplicate ZIP entry: {name}")
                    files[name] = archive.read(info)
    except (zipfile.BadZipFile, OSError) as exc:
        raise EpubError(f"Cannot read EPUB: {exc}") from exc
    if "META-INF/encryption.xml" in files:
        raise EpubError("Encrypted/DRM or font-obfuscated EPUB is unsupported")
    try:
        container = _xml(files["META-INF/container.xml"])
        package_path = next(
            el.attrib["full-path"] for el in container.iter() if _tag(el) == "rootfile"
        )
        package_path = _resolve("", package_path)
        package = _xml(files[package_path])
        if any(
            _tag(el) == "meta"
            and (
                el.attrib.get("property") == "rendition:layout"
                and (el.text or "").strip() == "pre-paginated"
            )
            for el in package.iter()
        ):
            raise EpubError("Fixed layout EPUB is unsupported")
        manifest = {el.attrib["id"]: el for el in package.iter() if _tag(el) == "item"}
        title = next(
            (el.text for el in package.iter() if _tag(el) == "title" and el.text),
            "EPUB",
        )
        resources: list[dict[str, object]] = []
        product_budget = [0]
        warnings: list[str] = []
        spine = [el for el in package.iter() if _tag(el) == "itemref"]
        if spine and all(
            "rendition:layout-pre-paginated" in el.attrib.get("properties", "").split()
            for el in spine
        ):
            raise EpubError("Fixed layout EPUB is unsupported")
        for itemref in spine:
            fixed_item = (
                "rendition:layout-pre-paginated" in itemref.attrib.get("properties", "").split()
            )
            item = manifest[itemref.attrib["idref"]]
            if item.attrib.get("media-type") != "application/xhtml+xml":
                raise EpubError("Only XHTML spine resources are supported")
            href = _resolve(package_path, item.attrib["href"])
            fragment, text, notes = sanitize_xhtml(files[href], href, files, product_budget)
            warnings.extend(notes)
            if fixed_item:
                if text.strip() or "<img " not in fragment:
                    raise EpubError(
                        "Fixed layout spine item with text or unsupported image is unsupported"
                    )
                warnings.append(f"Fixed image page rendered without fixed-layout geometry: {href}")
            document = _xml(files[href])
            styles: list[str] = []
            for el in document.iter():
                style: str | None = None
                if _tag(el) == "style":
                    style = _inline_css("".join(el.itertext()), href, files, warnings)
                elif _tag(el) == "link" and "stylesheet" in el.attrib.get("rel", "").split():
                    try:
                        css_path = _resolve(href, el.attrib["href"])
                        style = _inline_css(
                            files[css_path].decode("utf-8-sig"),
                            css_path,
                            files,
                            warnings,
                            (css_path,),
                        )
                    except (EpubError, KeyError, UnicodeError):
                        warnings.append(f"Skipped unavailable stylesheet in {href}")
                if style is not None:
                    _spend(product_budget, len(style.encode()))
                    styles.append(style)
            resource_title = next(
                (el.text for el in document.iter() if _tag(el) == "title" and el.text),
                href,
            )
            resources.append(
                {
                    "id": item.attrib["id"],
                    "href": href,
                    "title": resource_title,
                    "text": text,
                    "html": fragment,
                    "css": "\n".join(styles),
                    "htmlAttributes": _presentation_attributes(document),
                    "bodyAttributes": _presentation_attributes(
                        next(
                            (el for el in document.iter() if _tag(el) == "body"),
                            document,
                        )
                    ),
                    "textSha256": hashlib.sha256(text.encode()).hexdigest(),
                }
            )
    except (KeyError, StopIteration) as exc:
        raise EpubError(f"Incomplete EPUB package: {exc}") from exc
    if not resources:
        raise EpubError("EPUB has no readable spine resources")
    result: dict[str, object] = {
        "contract": CONTRACT,
        "title": title,
        "warnings": warnings,
        "resources": resources,
    }
    digest = hashlib.sha256(RULES.encode())
    for name, payload in sorted(files.items()):
        digest.update(name.encode() + b"\0" + hashlib.sha256(payload).digest())
    digest.update(json.dumps(result, ensure_ascii=False, sort_keys=True).encode())
    result["materialVersion"] = digest.hexdigest()
    return result


class _FragmentParser(HTMLParser):
    """Split safe markup at original IDs while retaining ancestor context."""

    def __init__(self, markup: str) -> None:
        super().__init__(convert_charrefs=False)
        self.tokens: list[str] = []
        self.contexts: list[list[tuple[str, str]]] = []
        self.stack: list[tuple[str, str]] = []
        self.ids: dict[str, int] = {}
        self.leaves: list[tuple[int, int]] = []
        self.feed(markup)
        self.contexts.append(list(self.stack))

    def _append(self, value: str) -> None:
        self.contexts.append(list(self.stack))
        self.tokens.append(value)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if values.get("id"):
            self.ids.setdefault(str(values["id"]), len(self.tokens))
        if values.get("data-locator-leaf") is not None:
            self.leaves.append((len(self.tokens), int(str(values["data-locator-leaf"]))))
        raw = self.get_starttag_text() or ""
        self._append(raw)
        if tag not in {"img", "hr", "br"}:
            self.stack.append((tag, raw))

    def handle_endtag(self, tag: str) -> None:
        self._append(f"</{tag}>")
        if self.stack:
            self.stack.pop()

    def handle_data(self, data: str) -> None:
        self._append(data)

    def handle_entityref(self, name: str) -> None:
        self._append(f"&{name};")

    def handle_charref(self, name: str) -> None:
        self._append(f"&#{name};")

    def slice(self, start: int, end: int) -> str:
        return (
            "".join(raw for _, raw in self.contexts[start])
            + "".join(self.tokens[start:end])
            + "".join(f"</{tag}>" for tag, _ in reversed(self.contexts[end]))
        )


def _toc(
    files: dict[str, bytes],
    package_path: str,
    package: ET.Element,
    warnings: list[str],
    *,
    skip_nav: bool = False,
) -> list[tuple[str, str, int]]:
    items = [el for el in package.iter() if _tag(el) == "item"]
    nav = next((el for el in items if "nav" in el.attrib.get("properties", "").split()), None)
    if nav is not None and not skip_nav:
        try:
            path = _resolve(package_path, nav.attrib["href"])
            document = _xml(files[path])
            toc = next(
                el
                for el in document.iter()
                if _tag(el) == "nav"
                and "toc"
                in el.attrib.get(
                    "{http://www.idpf.org/2007/ops}type", el.attrib.get("type", "")
                ).split()
            )
            entries: list[tuple[str, str, int]] = []

            def walk(node: ET.Element, level: int) -> None:
                for child in node:
                    if _tag(child) == "li":
                        label = next((el for el in child if _tag(el) in {"a", "span"}), None)
                        if label is not None and label.attrib.get("href"):
                            entries.append(
                                (
                                    _label(label),
                                    path + "\0" + label.attrib["href"],
                                    level,
                                )
                            )
                        for nested in child:
                            if _tag(nested) == "ol":
                                walk(nested, level + 1)
                    elif _tag(child) == "ol":
                        walk(child, level)

            walk(toc, 0)
            if entries:
                return entries
            warnings.append("EPUB nav 目录没有有效链接，尝试 NCX。")
        except (EpubError, KeyError, StopIteration):
            warnings.append("EPUB nav 目录无法读取，尝试 NCX。")
    spine = next((el for el in package.iter() if _tag(el) == "spine"), None)
    ncx = next(
        (
            el
            for el in items
            if spine is not None and el.attrib.get("id") == spine.attrib.get("toc")
        ),
        None,
    )
    if ncx is None:
        ncx = next(
            (el for el in items if el.attrib.get("media-type") == "application/x-dtbncx+xml"), None
        )
    if ncx is not None:
        try:
            path = _resolve(package_path, ncx.attrib["href"])
            document = _xml(files[path])
            entries = []

            def walk_ncx(node: ET.Element, level: int) -> None:
                for child in node:
                    if _tag(child) == "navpoint":
                        label = next((el for el in child if _tag(el) == "navlabel"), None)
                        content = next((el for el in child if _tag(el) == "content"), None)
                        if label is not None and content is not None:
                            entries.append(
                                (
                                    _label(label),
                                    path + "\0" + content.attrib.get("src", ""),
                                    level,
                                )
                            )
                        walk_ncx(child, level + 1)
                    elif _tag(child) == "navmap":
                        walk_ncx(child, level)

            walk_ncx(document, 0)
            return entries
        except (EpubError, KeyError):
            warnings.append("EPUB NCX 目录无法读取。")
    return []


def compile_epub_bytes(data: bytes) -> CompiledBook:
    """Compile bytes without extraction, network access or mutable source identity."""
    try:
        legacy = cast(dict[str, Any], _compile_legacy(io.BytesIO(data)))
        resources = [
            CompiledResource.model_validate(
                {
                    **resource,
                    "html_attributes": resource["htmlAttributes"],
                    "body_attributes": resource["bodyAttributes"],
                    "text_sha256": resource["textSha256"],
                }
            )
            for resource in legacy["resources"]
        ]
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            files = {
                name: archive.read(name) for name in archive.namelist() if not name.endswith("/")
            }
        container = _xml(files["META-INF/container.xml"])
        package_path = _resolve(
            "", next(el.attrib["full-path"] for el in container.iter() if _tag(el) == "rootfile")
        )
        warnings = cast(list[str], list(legacy["warnings"]))
        entries = _toc(files, package_path, _xml(files[package_path]), warnings)
        if len({resource.href for resource in resources}) != len(resources):
            warnings.append("spine 重复资源保留全部出现位置；目录目标定位到首次出现。")
        parsers = [_FragmentParser(resource.html) for resource in resources]

        def resolve_entries(
            candidates: list[tuple[str, str, int]],
        ) -> list[tuple[str, int, int, int]]:
            positions: list[tuple[str, int, int, int]] = []
            for title, target, level in candidates:
                base, url = target.split("\0", 1)
                try:
                    href = _resolve(base, url)
                    index = next(i for i, resource in enumerate(resources) if resource.href == href)
                    fragment = unquote(urlsplit(url).fragment)
                    token = parsers[index].ids[fragment] if fragment else 0
                    leaf_boundary = next(
                        (
                            leaf
                            for token_index, leaf in parsers[index].leaves
                            if token_index >= token
                        ),
                        len(parsers[index].leaves),
                    )
                    raw = re.findall(
                        r'<span data-locator-leaf="\d+">(.*?)</span>',
                        resources[index].html,
                        re.DOTALL,
                    )
                    left = html.unescape("".join(raw[:leaf_boundary]))
                    right = html.unescape("".join(raw[leaf_boundary:]))
                    if (
                        unicodedata.normalize("NFC", left) + unicodedata.normalize("NFC", right)
                        != resources[index].text
                    ):
                        warnings.append(f"目录边界跨越 NFC 组合字符，已跳过：{title}")
                        continue
                    position = (index, token)
                    if positions and position <= (positions[-1][2], positions[-1][3]):
                        warnings.append(f"目录目标重复或逆序，已跳过：{title}")
                        continue
                    positions.append((title or resources[index].title, level, index, token))
                except (EpubError, KeyError, StopIteration):
                    warnings.append(f"目录目标缺失或无效，已跳过：{title}")
            return positions

        positions = resolve_entries(entries)
        if not positions:
            fallback_entries = _toc(
                files, package_path, _xml(files[package_path]), warnings, skip_nav=True
            )
            if fallback_entries and fallback_entries != entries:
                warnings.append("nav 目录没有有效正文目标，尝试 NCX。")
                positions = resolve_entries(fallback_entries)
        if not positions:
            warnings.append("没有有效目录，按原始 spine 资源组织阅读。")
            positions = [(resource.title, 0, index, 0) for index, resource in enumerate(resources)]
        elif positions[0][2:] != (0, 0):
            warnings.append("目录之前的内容保留为前置内容；末项之后的内容保留在末章。")
            positions.insert(0, ("前置内容", 0, 0, 0))
        part_budget = [
            sum(
                len(resource.html.encode())
                + len(resource.css.encode())
                + len(resource.text.encode())
                for resource in resources
            )
        ]
        chapters: list[CompiledChapter] = []
        for chapter_index, (title, level, first, first_token) in enumerate(positions):
            last, last_token = (
                positions[chapter_index + 1][2:]
                if chapter_index + 1 < len(positions)
                else (len(resources) - 1, len(parsers[-1].tokens))
            )
            parts: list[ChapterPart] = []
            for index in range(first, last + 1):
                parser = parsers[index]
                start_token = first_token if index == first else 0
                end_token = last_token if index == last else len(parser.tokens)
                if start_token == end_token:
                    continue
                leaf_start = next(
                    (leaf for token, leaf in parser.leaves if token >= start_token),
                    len(parser.leaves),
                )
                leaf_end = next(
                    (leaf for token, leaf in parser.leaves if token >= end_token),
                    len(parser.leaves),
                )
                raw_leaves = re.findall(
                    r'<span data-locator-leaf="\d+">(.*?)</span>', resources[index].html, re.DOTALL
                )
                start = len(
                    unicodedata.normalize(
                        "NFC", "".join(html.unescape(value) for value in raw_leaves[:leaf_start])
                    )
                )
                end = len(
                    unicodedata.normalize(
                        "NFC", "".join(html.unescape(value) for value in raw_leaves[:leaf_end])
                    )
                )
                _spend(
                    part_budget,
                    sum(len(value.encode()) for value in parser.tokens[start_token:end_token])
                    + sum(len(raw.encode()) for _, raw in parser.contexts[start_token])
                    + 1024,
                )
                parts.append(
                    ChapterPart(
                        resource_id=resources[index].id,
                        spine_index=index,
                        start=start,
                        end=end,
                        html=parser.slice(start_token, end_token),
                        leaf_start=leaf_start,
                        leaf_end=leaf_end,
                    )
                )
            chapters.append(
                CompiledChapter(
                    id=f"chapter-{chapter_index}", title=title, level=level, parts=parts
                )
            )
        book = CompiledBook(
            contract=CONTRACT,
            title=str(legacy["title"]),
            warnings=warnings,
            resources=resources,
            chapters=chapters,
            product_sha256="",
        )
        return book.model_copy(
            update={
                "product_sha256": hashlib.sha256(
                    (RULES + book.model_dump_json()).encode()
                ).hexdigest()
            }
        )
    except EpubError as exc:
        raise EpubError(f"无法导入 EPUB：{exc}") from exc
    except (KeyError, StopIteration, ValueError, RecursionError) as exc:
        raise EpubError(f"EPUB 内容无效或不受支持：{exc}") from exc


# Stable compatibility surface for the offline CLI and pre-extraction regression suite.
parse_xml = _xml
inline_css = _inline_css
presentation_attributes = _presentation_attributes


def parse_package_xml(data: bytes) -> ET.Element:
    """Shared bounded/entity-safe XML parser for rebuildable display extraction."""
    return _xml(data)


def resolve_package_path(base: str, target: str) -> str:
    """Resolve local package paths under the compiler's established safety boundary."""
    return _resolve(base, target)


def package_tag(element: ET.Element) -> str:
    return _tag(element)
