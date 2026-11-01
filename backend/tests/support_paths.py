"""Filesystem capabilities required by a small subset of security regressions."""

import errno
from pathlib import Path

import pytest


def symlink_or_skip(link: Path, target: Path | str, *, target_is_directory: bool = False) -> None:
    try:
        link.symlink_to(target, target_is_directory=target_is_directory)
    except NotImplementedError:
        pytest.skip("This filesystem does not support symbolic links")
    except OSError as exc:
        if (
            exc.errno in {errno.EACCES, errno.EPERM, errno.ENOSYS, errno.ENOTSUP}
            or getattr(exc, "winerror", None) == 1314
        ):
            pytest.skip(f"Symbolic links are unavailable in this test environment: {exc}")
        raise
