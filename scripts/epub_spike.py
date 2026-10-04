"""Offline compatibility CLI for the production EPUB compiler."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend" / "src"))
from app.services import epub as _compiler

EpubError = _compiler.EpubError
compile_epub_bytes = _compiler.compile_epub_bytes
sanitize_xhtml = _compiler.sanitize_xhtml
_xml = _compiler.parse_xml
_inline_css = _compiler.inline_css
_presentation_attributes = _compiler.presentation_attributes


def compile_epub(path: Path) -> dict[str, object]:
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise EpubError(f"无法读取 EPUB 文件：{path}（{exc.strerror}）") from exc
    book = compile_epub_bytes(data)
    result = book.model_dump()
    result["contract"] = "epub-spike-v1"
    result["materialVersion"] = result.pop("product_sha256")
    for resource in result["resources"]:
        for old, new in (
            ("html_attributes", "htmlAttributes"),
            ("body_attributes", "bodyAttributes"),
            ("text_sha256", "textSha256"),
        ):
            resource[new] = resource.pop(old)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("epub", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    output = (
        args.output
        or Path("prototypes/epub-reading/public/books") / f"{args.epub.stem}.json"
    )
    try:
        result = compile_epub(args.epub)
    except (EpubError, OSError) as exc:
        parser.exit(2, f"EPUB error: {exc}\n")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(output)


if __name__ == "__main__":
    main()
