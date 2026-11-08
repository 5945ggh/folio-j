"""Separate immutable bundled assets from installation-local configuration and data."""

import sys
from pathlib import Path


def resource_root() -> Path:
    """PyInstaller preserves repository-relative assets underneath its bundle root."""
    if getattr(sys, "frozen", False):
        bundle = getattr(sys, "_MEIPASS", None)
        if not isinstance(bundle, str):
            raise RuntimeError("冻结程序缺少资源目录")
        return Path(bundle).resolve()
    return Path(__file__).resolve().parents[3]


def installation_root() -> Path:
    """Keep relative user paths beside the executable, outside the immutable bundle."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return resource_root()


RESOURCE_ROOT = resource_root()
PROMPTS = RESOURCE_ROOT / "backend" / "prompts"
