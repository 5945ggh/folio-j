"""Bounded stdlib EPUB compilation with immutable resource-local reading identity."""

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
from bisect import bisect_left
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, cast
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET
from xml.parsers import expat

from app.epub_schemas import ChapterPart, CompiledBook, CompiledChapter, CompiledResource

CONTRACT = "epub-reading-v2"
MAX_PRODUCT_BYTES = 64 * 1024 * 1024
MAX_NFC_BOUNDARY_PROBES = 8
RULES = (
    "xml-xhtml;allowlist-v1;block-end-newline;raw-leaves-global-NFC;rt-rp-excluded;"
    "isolated-fixed-raster-v1;css-import-v1;document-attributes-v1;toc-ranges-v1;"
    "chapter-html-only-v2"
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
    """Unsupported or unsafe EPUB input."""


class EpubLimitError(EpubError):
    """Safety limit failures cannot be downgraded to optional-resource warnings."""


def _spend(budget: list[int], amount: int) -> None:
    budget[0] += amount
    if budget[0] > MAX_PRODUCT_BYTES:
        raise EpubLimitError("处理后的书籍内容超过安全大小限制")


def _spend_json(budget: list[int], value: Any) -> None:
    """Count compact UTF-8 JSON without allocating the complete serialized value."""
    if isinstance(value, str):
        _spend(budget, 2)
        for start in range(0, len(value), 4096):
            encoded = json.dumps(value[start : start + 4096], ensure_ascii=False)
            _spend(budget, len(encoded.encode()) - 2)
    elif isinstance(value, dict):
        values = cast(dict[str, Any], value)
        _spend(budget, 2 + max(0, len(values) - 1) + len(values))
        for key, item in values.items():
            _spend_json(budget, key)
            _spend_json(budget, item)
    elif isinstance(value, list):
        values_list = cast(list[Any], value)
        _spend(budget, 2 + max(0, len(values_list) - 1))
        for item in values_list:
            _spend_json(budget, item)
    else:
        _spend(budget, len(json.dumps(value).encode()))


class _BudgetedWarnings(list[str]):
    """Account each warning before retaining it, including optional-resource paths."""

    def __init__(self, budget: list[int]) -> None:
        super().__init__()
        self.budget = budget

    def append(self, value: str) -> None:
        _spend(self.budget, int(bool(self)))
        _spend_json(self.budget, value)
        super().append(value)

    def extend(self, values: Iterable[str]) -> None:
        for value in values:
            self.append(value)


def _label(element: ET.Element) -> str:
    def text(node: ET.Element) -> str:
        if _tag(node) in {"rt", "rp"}:
            return ""
        return (node.text or "") + "".join(text(child) + (child.tail or "") for child in node)

    return unicodedata.normalize("NFC", " ".join(text(element).split()))


def _tag(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1].lower()


def _xml(data: bytes, path: str | None = None) -> ET.Element:
    location = f"（{path}）" if path is not None else ""

    def reject_entity(*_arguments: object) -> None:
        raise EpubError(f"书籍中的 XML 文件含有不支持的实体声明{location}")

    # Expat detects declarations after decoding the document's declared encoding.
    # Reject before ElementTree can expand any internal entities.
    parser = expat.ParserCreate()
    depth = [0]

    def start_element(_name: str, _attributes: dict[str, str]) -> None:
        depth[0] += 1
        if depth[0] > 128:
            raise EpubError(f"书籍中的 XML 文件结构过于复杂，无法安全读取{location}")

    def end_element(_name: str) -> None:
        depth[0] -= 1

    parser.StartElementHandler = start_element
    parser.EndElementHandler = end_element
    parser.EntityDeclHandler = reject_entity
    try:
        parser.Parse(data, True)
        return ET.fromstring(data)
    except (ET.ParseError, expat.ExpatError) as exc:
        line, column = exc.position if isinstance(exc, ET.ParseError) else (exc.lineno, exc.offset)
        raise EpubError(
            f"书籍中的 XML / XHTML 文件格式有误{location}，第 {line} 行第 {column + 1} 列"
        ) from exc


def _resolve(base: str, target: str) -> str:
    parts = urlsplit(target)
    if parts.scheme or parts.netloc or parts.query:
        raise EpubError(f"无法读取书籍外部的资源：{target}")
    decoded = unquote(parts.path)
    if not decoded:
        return base
    if "\\" in decoded or decoded.startswith("/"):
        raise EpubError(f"书籍中的资源路径不安全：{target}")
    path = posixpath.normpath(posixpath.join(posixpath.dirname(base), decoded))
    if path == ".." or path.startswith("../"):
        raise EpubError(f"资源路径指向书籍以外的位置：{target}")
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
    root = _xml(data, href)
    body = next((el for el in root.iter() if _tag(el) == "body"), root)
    leaves: list[str] = []
    image_count = [0]
    warnings: list[str] = _BudgetedWarnings(budget)

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
                    raise EpubError("图片缺失或格式不受支持")
                _spend(budget, (len(payload) + 2) // 3 * 4)
                attrs.append(f' src="data:{mime};base64,{base64.b64encode(payload).decode()}"')
                attrs.append(f' alt="{html.escape(node.attrib.get("alt", ""), quote=True)}"')
            except EpubLimitError:
                raise
            except EpubError:
                warnings.append(f"图片无法读取或格式不受支持，已跳过：{href}")
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
        raise EpubError(f"合并前的样式文件总大小超过 4 MB：{href}")
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
            warnings.append(f"样式引用的写法不受支持，已跳过：{href}（{statement}）")
            return ""
        target = next(value for value in parsed.groups()[:5] if value is not None)
        media = parsed.group(6).strip()
        if media and not re.fullmatch(r"[a-zA-Z0-9 ,():.\-]+", media):
            warnings.append(f"样式引用的适用条件不受支持，已跳过：{href}（{media}）")
            return ""
        try:
            imported_path = _resolve(href, target)
            if imported_path in stack or len(stack) >= 8:
                raise EpubError("样式文件相互引用或引用层数过多")
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
        except EpubLimitError:
            raise
        except (EpubError, KeyError, UnicodeError) as exc:
            reason = str(exc) if isinstance(exc, EpubError) else "文件缺失或无法读取"
            warnings.append(f"样式引用已跳过：{href} 中的 {target}（{reason}）")
            return ""

    expanded = pattern.sub(expand, css)
    if re.search(r"@import\b", expanded, re.IGNORECASE):
        warnings.append(f"样式引用未正确结束，已移除：{href}")
        expanded = re.sub(r"@import\b.*", "", expanded, flags=re.IGNORECASE | re.DOTALL)
    if len(expanded.encode()) > 4 * 1024 * 1024:
        raise EpubError(f"合并后的样式超过 4 MB：{href}")
    return expanded


@dataclass(frozen=True)
class _Publication:
    """Validated resources and temporary HTML used only while building chapters."""

    files: dict[str, bytes]
    package_path: str
    package: ET.Element
    title: str
    resources: list[CompiledResource]
    resource_html: list[str]
    warnings: _BudgetedWarnings
    output_budget: list[int]


def _read_archive(data: bytes) -> dict[str, bytes]:
    """Validate ZIP metadata before reading each local member once, without extraction."""
    files: dict[str, bytes] = {}
    current_file: str | None = None
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = archive.infolist()
            if len(infos) > 5000 or sum(info.file_size for info in infos) > 128 * 1024 * 1024:
                raise EpubError("书籍解压后超过 5000 项或 128 MB，请尝试体积更小的 EPUB 文件")
            names: set[str] = set()
            for info in infos:
                name = info.filename
                if name.startswith("/") or "\\" in name or ".." in name.split("/"):
                    raise EpubError(f"书籍中存在不安全的文件路径：{name}")
                if info.flag_bits & 1:
                    raise EpubError("书籍含有加密文件，请选择未加密的 EPUB 文件")
                if (
                    info.file_size > 16 * 1024 * 1024
                    or info.file_size / max(info.compress_size, 1) > 200
                ):
                    raise EpubError(
                        f"书籍中单个文件解压后超过 16 MB 或超过压缩后大小的 200 倍：{name}"
                    )
                if not info.is_dir():
                    if name in names:
                        raise EpubError(f"书籍中存在同名文件：{name}")
                    names.add(name)
            if "META-INF/encryption.xml" in names:
                raise EpubError("请换用不含 DRM 保护、加密文件或混淆字体的 EPUB 文件")
            for info in infos:
                if not info.is_dir():
                    current_file = info.filename
                    files[info.filename] = archive.read(info)
    except (zipfile.BadZipFile, OSError) as exc:
        location = f"（{current_file}）" if current_file is not None else ""
        raise EpubError(f"文件无法读取或已损坏{location}，请检查原文件") from exc
    return files


def _prepare_publication(data: bytes) -> _Publication:
    files = _read_archive(data)
    try:
        container_path = "META-INF/container.xml"
        container = _xml(files[container_path], container_path)
        package_path = next(
            el.attrib["full-path"] for el in container.iter() if _tag(el) == "rootfile"
        )
        package_path = _resolve("", package_path)
        package = _xml(files[package_path], package_path)
        if any(
            _tag(el) == "meta"
            and (
                el.attrib.get("property") == "rendition:layout"
                and (el.text or "").strip() == "pre-paginated"
            )
            for el in package.iter()
        ):
            raise EpubError("本书采用固定版式，请选择支持重排版式的 EPUB 文件")
        manifest = {el.attrib["id"]: el for el in package.iter() if _tag(el) == "item"}
        title = next(
            (el.text for el in package.iter() if _tag(el) == "title" and el.text),
            "EPUB",
        )
        resources: list[CompiledResource] = []
        resource_html: list[str] = []
        product_budget = [0]
        output_budget = [0]
        _spend_json(
            output_budget,
            {
                "contract": CONTRACT,
                "title": title,
                "warnings": [],
                "resources": [],
                "chapters": [],
                "product_sha256": "0" * 64,
            },
        )
        warnings = _BudgetedWarnings(output_budget)
        spine = [el for el in package.iter() if _tag(el) == "itemref"]
        if spine and all(
            "rendition:layout-pre-paginated" in el.attrib.get("properties", "").split()
            for el in spine
        ):
            raise EpubError("本书采用固定版式，请选择支持重排版式的 EPUB 文件")
        for itemref in spine:
            fixed_item = (
                "rendition:layout-pre-paginated" in itemref.attrib.get("properties", "").split()
            )
            item = manifest[itemref.attrib["idref"]]
            if item.attrib.get("media-type") != "application/xhtml+xml":
                raise EpubError(f"章节内容须为 XHTML 格式：{item.attrib.get('href', '未指定文件')}")
            href = _resolve(package_path, item.attrib["href"])
            fragment, text, notes = sanitize_xhtml(files[href], href, files, product_budget)
            warnings.extend(notes)
            if fixed_item:
                if text.strip() or "<img " not in fragment:
                    raise EpubError(
                        f"本书含有无法导入的固定版式页面，页面包含文字或无法显示的图片：{href}"
                    )
                warnings.append(f"固定版式的图片页已按普通图片显示：{href}")
            document = _xml(files[href], href)
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
                    except EpubLimitError:
                        raise
                    except (EpubError, KeyError, UnicodeError):
                        target = el.attrib.get("href", "未指定文件")
                        warnings.append(f"样式表无法读取，已跳过：{href}（{target}）")
                if style is not None:
                    _spend(product_budget, len(style.encode()))
                    styles.append(style)
            resource_title = next(
                (el.text for el in document.iter() if _tag(el) == "title" and el.text),
                href,
            )
            resource = CompiledResource(
                id=item.attrib["id"],
                href=href,
                title=resource_title,
                text=text,
                css="\n".join(styles),
                html_attributes=_presentation_attributes(document),
                body_attributes=_presentation_attributes(
                    next(
                        (el for el in document.iter() if _tag(el) == "body"),
                        document,
                    )
                ),
                text_sha256=hashlib.sha256(text.encode()).hexdigest(),
            )
            _spend(output_budget, int(bool(resources)))
            _spend_json(output_budget, resource.model_dump())
            resources.append(resource)
            resource_html.append(fragment)
    except (KeyError, StopIteration) as exc:
        location = f"（{exc.args[0]}）" if exc.args else ""
        raise EpubError(f"书籍缺少必要的文件或信息{location}，请检查原文件") from exc
    if not resources:
        raise EpubError("本书没有可读的章节，请检查原文件")
    return _Publication(
        files, package_path, package, title, resources, resource_html, warnings, output_budget
    )


def _canonical_units(value: str) -> Iterator[tuple[str, int]]:
    """Yield canonical NFD units with their original codepoint positions."""
    pending: list[tuple[str, int]] = []
    for index, character in enumerate(value):
        for unit in unicodedata.normalize("NFD", character):
            if not unicodedata.combining(unit):
                yield from sorted(pending, key=lambda item: unicodedata.combining(item[0]))
                pending.clear()
                yield unit, index
            else:
                pending.append((unit, index))
    yield from sorted(pending, key=lambda item: unicodedata.combining(item[0]))


def _locator_boundaries(raw_leaves: list[str], text: str) -> list[int | None]:
    """Index safe NFC offsets; the globally normalized text remains authoritative.

    Canonical NFD streams are identical before/after NFC. Stable alignment maps
    each normalized codepoint to its original contributors, including Hangul
    and reordered marks. A leaf boundary is safe exactly when every preceding
    output contributor precedes it and every following contributor follows it.
    No independently normalized leaf is used as the published locator text.
    """
    raw = "".join(raw_leaves)
    boundaries = [0]
    for leaf in raw_leaves:
        boundaries.append(boundaries[-1] + len(leaf))
    if raw == text:
        return list(boundaries)
    first = [len(raw)] * len(text)
    last = [-1] * len(text)
    for (unit, source), (normalized_unit, target) in zip(
        _canonical_units(raw), _canonical_units(text), strict=True
    ):
        if unit != normalized_unit:
            raise EpubError("无法准确定位正文，请检查原文件")
        first[target] = min(first[target], source)
        last[target] = max(last[target], source)
    # Reuse the contributor arrays for cumulative bounds rather than retaining
    # two additional arrays proportional to the resource's codepoint count.
    for index in range(1, len(text)):
        last[index] = max(last[index - 1], last[index])
    first.append(len(raw))
    for index in range(len(text) - 1, -1, -1):
        first[index] = min(first[index + 1], first[index])
    offsets: list[int | None] = []
    for boundary in boundaries:
        offset = bisect_left(last, boundary)
        offsets.append(offset if first[offset] >= boundary else None)
    return offsets


class _FragmentParser(HTMLParser):
    """Split safe markup at original IDs while retaining ancestor context."""

    def __init__(self, markup: str, text: str) -> None:
        super().__init__(convert_charrefs=False)
        self.tokens: list[str] = []
        self.contexts: list[list[tuple[str, str]]] = []
        self.stack: list[tuple[str, str]] = []
        self.ids: dict[str, int] = {}
        self.leaves: list[tuple[int, int]] = []
        self.feed(markup)
        self.contexts.append(list(self.stack))
        self.leaf_tokens = [token for token, _ in self.leaves]
        self.raw_leaves = [
            html.unescape(value)
            for value in re.findall(
                r'<span data-locator-leaf="\d+">(.*?)</span>', markup, re.DOTALL
            )
        ]
        self.raw = "".join(self.raw_leaves)
        self.text = text
        self.already_nfc = self.raw == text
        self.raw_offsets = [0]
        for leaf in self.raw_leaves:
            self.raw_offsets.append(self.raw_offsets[-1] + len(leaf))
        self.offset_cache: dict[int, int | None] = {}
        self.offsets: list[int | None] | None = None

    def leaf_boundary(self, token: int) -> int:
        return bisect_left(self.leaf_tokens, token)

    def locator_offset(self, boundary: int) -> int | None:
        if self.already_nfc:
            return self.raw_offsets[boundary]
        if boundary == 0:
            return 0
        if boundary == len(self.raw_leaves):
            return len(self.text)
        if self.offsets is not None:
            return self.offsets[boundary]
        if boundary not in self.offset_cache:
            if len(self.offset_cache) >= MAX_NFC_BOUNDARY_PROBES:
                # Dense TOCs amortize the full codepoint map. Sparse TOCs use
                # bounded C-level normalization passes regardless of leaf count.
                self.offsets = _locator_boundaries(self.raw_leaves, self.text)
                return self.offsets[boundary]
            position = self.raw_offsets[boundary]
            left = unicodedata.normalize("NFC", self.raw[:position])
            right = unicodedata.normalize("NFC", self.raw[position:])
            self.offset_cache[boundary] = len(left) if left + right == self.text else None
        return self.offset_cache[boundary]

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
            document = _xml(files[path], path)
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
            warnings.append(f"目录没有可用链接，将尝试读取备用目录：{path}")
        except EpubLimitError:
            raise
        except (EpubError, KeyError, StopIteration):
            target = nav.attrib.get("href", "未指定文件")
            warnings.append(f"目录无法读取，将尝试读取备用目录：{target}")
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
            document = _xml(files[path], path)
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
        except EpubLimitError:
            raise
        except (EpubError, KeyError):
            target = ncx.attrib.get("href", "未指定文件")
            warnings.append(f"备用目录无法读取：{target}")
    return []


def compile_epub_bytes(data: bytes) -> CompiledBook:
    """Compile bytes without extraction, network access or mutable source identity."""
    try:
        publication = _prepare_publication(data)
        files, resources = publication.files, publication.resources
        output_budget, warnings = publication.output_budget, publication.warnings
        entries = _toc(files, publication.package_path, publication.package, warnings)
        if len({resource.href for resource in resources}) != len(resources):
            warnings.append("目录链接指向重复正文时会跳到首次出现的位置，重复正文均已保留")
        parser_by_href: dict[str, _FragmentParser] = {}
        first_by_href: dict[str, int] = {}
        parsers: list[_FragmentParser] = []
        for index, (resource, markup) in enumerate(
            zip(resources, publication.resource_html, strict=True)
        ):
            if resource.href not in parser_by_href:
                parser_by_href[resource.href] = _FragmentParser(markup, resource.text)
                first_by_href[resource.href] = index
            parsers.append(parser_by_href[resource.href])

        def resolve_entries(
            candidates: list[tuple[str, str, int]],
        ) -> list[tuple[str, int, int, int]]:
            positions: list[tuple[str, int, int, int]] = []
            for title, target, level in candidates:
                base, url = target.split("\0", 1)
                label = f"「{title}」（{url}）" if title else url
                try:
                    href = _resolve(base, url)
                    index = first_by_href[href]
                    fragment = unquote(urlsplit(url).fragment)
                    token = parsers[index].ids[fragment] if fragment else 0
                    leaf_boundary = parsers[index].leaf_boundary(token)
                    if parsers[index].locator_offset(leaf_boundary) is None:
                        warnings.append(f"目录链接指向字符中间，已跳过：{label}")
                        continue
                    position = (index, token)
                    if positions and position <= (positions[-1][2], positions[-1][3]):
                        warnings.append(f"目录链接的位置重复或顺序有误，已跳过：{label}")
                        continue
                    positions.append((title or resources[index].title, level, index, token))
                except EpubLimitError:
                    raise
                except (EpubError, KeyError, StopIteration):
                    warnings.append(f"目录链接无法定位到正文，已跳过：{label}")
            return positions

        positions = resolve_entries(entries)
        if not positions:
            fallback_entries = _toc(
                files, publication.package_path, publication.package, warnings, skip_nav=True
            )
            if fallback_entries and fallback_entries != entries:
                warnings.append("目录中的链接无法定位到正文，将尝试使用备用目录")
                positions = resolve_entries(fallback_entries)
        if not positions:
            warnings.append("目录不可用，已按原书的正文顺序划分章节")
            positions = [(resource.title, 0, index, 0) for index, resource in enumerate(resources)]
        elif positions[0][2:] != (0, 0):
            warnings.append(
                "目录第一项之前的文字和图片保留为前置内容，最后一项之后的内容保留在末章"
            )
            positions.insert(0, ("前置内容", 0, 0, 0))
        part_budget = [
            sum(
                len(markup.encode()) + len(resource.css.encode()) + len(resource.text.encode())
                for resource, markup in zip(resources, publication.resource_html, strict=True)
            )
        ]
        chapters: list[CompiledChapter] = []
        for chapter_index, (title, level, first, first_token) in enumerate(positions):
            last, last_token = (
                positions[chapter_index + 1][2:]
                if chapter_index + 1 < len(positions)
                else (len(resources) - 1, len(parsers[-1].tokens))
            )
            _spend(output_budget, int(bool(chapters)))
            _spend_json(
                output_budget,
                {
                    "id": f"chapter-{chapter_index}",
                    "title": title,
                    "level": level,
                    "parts": [],
                },
            )
            parts: list[ChapterPart] = []
            for index in range(first, last + 1):
                parser = parsers[index]
                start_token = first_token if index == first else 0
                end_token = last_token if index == last else len(parser.tokens)
                if start_token == end_token:
                    continue
                leaf_start = parser.leaf_boundary(start_token)
                leaf_end = parser.leaf_boundary(end_token)
                start = parser.locator_offset(leaf_start)
                end = parser.locator_offset(leaf_end)
                if start is None or end is None:
                    raise EpubError(f"无法在字符中间划分章节：{resources[index].href}")
                _spend(
                    part_budget,
                    sum(len(value.encode()) for value in parser.tokens[start_token:end_token])
                    + sum(len(raw.encode()) for _, raw in parser.contexts[start_token])
                    + 1024,
                )
                part = ChapterPart(
                    resource_id=resources[index].id,
                    spine_index=index,
                    start=start,
                    end=end,
                    html=parser.slice(start_token, end_token),
                    leaf_start=leaf_start,
                    leaf_end=leaf_end,
                )
                _spend(output_budget, int(bool(parts)))
                _spend_json(output_budget, part.model_dump())
                parts.append(part)
            chapters.append(
                CompiledChapter(
                    id=f"chapter-{chapter_index}", title=title, level=level, parts=parts
                )
            )
        book = CompiledBook(
            contract=CONTRACT,
            title=publication.title,
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
    except EpubLimitError as exc:
        raise EpubLimitError(f"无法导入 EPUB：{exc}") from exc
    except EpubError as exc:
        raise EpubError(f"无法导入 EPUB：{exc}") from exc
    except (KeyError, StopIteration, ValueError, RecursionError) as exc:
        raise EpubError("EPUB 内容无效或格式不受支持，请检查原文件") from exc


# Stable pure-function test surface for XML, CSS and presentation rules.
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
