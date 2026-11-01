"""Platform differences for local file locks and durable directory publication."""

from __future__ import annotations

import importlib
import os
import stat
from collections.abc import Callable, Generator
from contextlib import contextmanager
from pathlib import Path
from typing import cast

_WINDOWS = os.name == "nt"


class FileLockError(OSError):
    """The lock file is unsafe or another process holds its exclusive lock."""


def is_link_or_reparse(path: Path) -> bool:
    """Reject symbolic links and Windows junctions or other reparse points."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
    )


@contextmanager
def exclusive_file_lock(path: Path) -> Generator[None, None, None]:
    """Hold a nonblocking kernel lock; closing or process exit always releases it."""
    descriptor: int | None = None
    try:
        if is_link_or_reparse(path):
            raise OSError("进程锁不能是链接或 reparse point")
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        info = os.fstat(descriptor)
        current = path.lstat()
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or is_link_or_reparse(path)
            or (info.st_dev, info.st_ino) != (current.st_dev, current.st_ino)
        ):
            raise OSError("进程锁不是安全的普通文件")
        if _WINDOWS:
            msvcrt = importlib.import_module("msvcrt")

            # A persistent byte gives every process the same region to lock.
            if info.st_size == 0:
                os.write(descriptor, b"\0")
            os.lseek(descriptor, 0, os.SEEK_SET)
            # The stdlib stubs expose these members only on a Windows type-check
            # host, while this module must also pass checks on POSIX.
            locking = cast(Callable[[int, int, int], None], msvcrt.locking)
            locking(descriptor, int(msvcrt.LK_NBLCK), 1)
        else:
            fcntl = importlib.import_module("fcntl")

            flock = cast(Callable[[int, int], None], fcntl.flock)
            flock(descriptor, int(fcntl.LOCK_EX) | int(fcntl.LOCK_NB))
    except OSError as exc:
        if descriptor is not None:
            os.close(descriptor)
        raise FileLockError(str(exc)) from exc
    try:
        yield
    finally:
        os.close(descriptor)


def fsync_directory(path: Path) -> None:
    """Flush directory metadata on POSIX; Windows retains file-content flushing only."""
    if _WINDOWS:
        # Python cannot portably open a Windows directory for os.fsync. Do not
        # promise power-loss durability of directory entries on this platform.
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def publish_directory(staging: Path, destination: Path) -> None:
    """Rename a staged tree without replacing an existing destination."""
    if _WINDOWS:
        # Windows rename already refuses every existing destination, even an
        # empty directory. A POSIX-style mkdir claim would prevent publication.
        os.rename(staging, destination)
        return
    destination.mkdir(mode=0o700)
    try:
        os.rename(staging, destination)
    except BaseException:
        destination.rmdir()
        raise
