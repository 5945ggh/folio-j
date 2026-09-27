"""Pure, lossless Markdown section splitter (normalizer v1)."""

import re
from dataclasses import dataclass

from markdown_it import MarkdownIt

NORMALIZER_VERSION = 1
_PARSER = MarkdownIt("commonmark")
_LINE = re.compile(r"[^\r\n]*(?:\r\n|\r|\n|$)")


def split_source_lines(source: str) -> list[str]:
    """Split only at CommonMark line endings, preserving each original terminator."""
    return [line for line in _LINE.findall(source) if line]


@dataclass(frozen=True)
class Heading:
    level: int
    title: str
    line: int
    end_line: int


@dataclass(frozen=True)
class Block:
    kind: str
    title: str | None
    raw: str
    start_line: int
    end_line: int
    display_no: str
    subheadings: tuple[Heading, ...]
    heading_lines: int


@dataclass(frozen=True)
class NormalizedDoc:
    source: str
    blocks: tuple[Block, ...]
    warnings: tuple[str, ...]


def _headings(lines: list[str]) -> list[Heading]:
    result: list[Heading] = []
    tokens = _PARSER.parse("".join(lines))
    for index, token in enumerate(tokens):
        if token.type != "heading_open" or token.map is None or token.level != 0:
            continue
        title = ""
        # markdown-it-py always emits inline content immediately after heading_open.
        if index + 1 < len(tokens):
            title = tokens[index + 1].content.strip()
        result.append(Heading(int(token.tag[1:]), title, token.map[0], token.map[1]))
    return result


def normalize(source: str, prev: NormalizedDoc | None = None) -> NormalizedDoc:
    """Return deterministic blocks; ``prev`` does not imply identity matching."""
    _ = prev
    lines = split_source_lines(source)
    headings = _headings(lines)
    h2 = [heading for heading in headings if heading.level == 2]
    starts = [0, *(heading.line for heading in h2), len(lines)]
    # The first boundary may be zero when the document starts with h2.
    boundaries = sorted(set(starts))
    blocks: list[Block] = []
    h2_by_line = {heading.line: heading for heading in h2}
    for boundary_index in range(len(boundaries) - 1):
        start, end = boundaries[boundary_index], boundaries[boundary_index + 1]
        heading = h2_by_line.get(start)
        kind = "section" if heading is not None else "preamble"
        number = len([block for block in blocks if block.kind == "section"]) + 1
        subs = tuple(h for h in headings if h.level == 3 and start < h.line < end)
        blocks.append(
            Block(
                kind=kind,
                title=heading.title if heading is not None else None,
                raw="".join(lines[start:end]),
                start_line=start + 1,
                end_line=end,
                display_no=f"LO-{number}" if heading is not None else "P",
                subheadings=subs,
                heading_lines=heading.end_line - heading.line if heading is not None else 0,
            )
        )
    if not blocks:
        blocks.append(Block("preamble", None, "", 1, 0, "P", (), 0))
    if blocks[0].kind == "section":
        blocks.insert(0, Block("preamble", None, "", 1, 0, "P", (), 0))
    warnings: list[str] = []
    if not h2:
        warnings.append("no_h2")
    if any(h.level == 1 for h in headings):
        warnings.append("h1_present")
    titles = [h.title for h in h2]
    if len(titles) != len(set(titles)):
        warnings.append("duplicate_title")
    if any(block.kind == "section" and not _section_body(block) for block in blocks):
        warnings.append("empty_section")
    return NormalizedDoc(source, tuple(blocks), tuple(warnings))


def _section_body(block: Block) -> str:
    return "".join(split_source_lines(block.raw)[block.heading_lines :]).strip()
