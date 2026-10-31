"""Check local links in maintained documentation and asset entry points."""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
LINK = re.compile(r"\[[^\]]*\]\(([^)]+)\)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--private-evidence", action="store_true", help="同时要求私有验收证据路径存在"
    )
    args = parser.parse_args()
    private_evidence = ROOT / "data" / "acceptance-evidence"
    paths = [ROOT / "README.md", ROOT / "AGENTS.md"]
    paths.extend(sorted((ROOT / "docs").rglob("*.md")))
    paths.extend(sorted((ROOT / "references").rglob("README.md")))
    paths.extend(sorted((ROOT / "prototypes").rglob("README.md")))
    errors: list[str] = []
    public_checked = 0
    private_checked = 0
    private_unchecked = 0
    for path in paths:
        for target in LINK.findall(path.read_text(encoding="utf-8")):
            if "://" in target or target.startswith(("#", "mailto:")):
                continue
            local = unquote(target.split("#", 1)[0].strip("<>"))
            resolved = (path.parent / local).resolve()
            if resolved.is_relative_to(private_evidence):
                if not args.private_evidence:
                    private_unchecked += 1
                    continue
                private_checked += 1
            else:
                public_checked += 1
            if not resolved.exists():
                errors.append(f"{path.relative_to(ROOT)}: {target}")
    print(
        f"已检查 {len(paths)} 份文档、{public_checked} 个公共本地链接；"
        f"私有证据已检查 {private_checked} 个、未核验 {private_unchecked} 个。"
    )
    if errors:
        print("存在失效的本地文档链接：\n" + "\n".join(errors))
        return 1
    print("已检查的路径均存在。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
