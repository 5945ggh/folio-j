"""Check local links in maintained documentation and asset entry points."""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
LINK = re.compile(r"\[[^\]]*\]\(([^)]+)\)")


def main() -> int:
    paths = [ROOT / "README.md", ROOT / "AGENTS.md"]
    paths.extend(sorted((ROOT / "docs").rglob("*.md")))
    paths.extend(sorted((ROOT / "references").rglob("README.md")))
    paths.extend(sorted((ROOT / "prototypes").rglob("README.md")))
    paths.extend(sorted((ROOT / "prototypes").rglob("VISUAL_BASELINE.md")))
    errors: list[str] = []
    count = 0
    for path in paths:
        for target in LINK.findall(path.read_text(encoding="utf-8")):
            if "://" in target or target.startswith(("#", "mailto:")):
                continue
            count += 1
            local = unquote(target.split("#", 1)[0].strip("<>"))
            if not (path.parent / local).exists():
                errors.append(f"{path.relative_to(ROOT)}: {target}")
    if errors:
        print("存在失效的本地文档链接：\n" + "\n".join(errors))
        return 1
    print(f"已检查 {len(paths)} 份文档、{count} 个本地链接，全部有效。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
