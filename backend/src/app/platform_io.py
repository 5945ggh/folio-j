"""Platform differences for local file locks and durable directory publication."""

from __future__ import annotations

import ctypes
import errno
import importlib
import os
import shutil
import stat
import sys
import tempfile
from collections.abc import Callable, Generator
from contextlib import contextmanager
from pathlib import Path
from typing import cast
from uuid import uuid4

_WINDOWS = os.name == "nt"
# Win32 IsReparseTagNameSurrogate: includes symlinks and junctions.
_REPARSE_NAME_SURROGATE = 0x20000000
_DARWIN_RENAME_EXCL = 0x00000004
_LINUX_RENAME_NOREPLACE = 1
_LINUX_AT_FDCWD = -100


class FileLockError(OSError):
    """The lock file is unsafe or another process holds its exclusive lock."""


def is_link_or_reparse(path: Path) -> bool:
    """Detect symbolic links and Windows reparse points that redirect a path."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(info.st_mode):
        return True
    if not getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        return False
    tag = getattr(info, "st_reparse_tag", 0)
    # Cloud placeholders and other metadata-only reparse points can be opened
    # in place. An unavailable tag gives no basis for allowing the path.
    return not tag or bool(tag & _REPARSE_NAME_SURROGATE)


def make_private_directory(path: Path, *, parents: bool = False, exist_ok: bool = False) -> None:
    """Use POSIX owner-only permissions and inherit the Windows parent ACL."""
    if _WINDOWS:
        path.mkdir(parents=parents, exist_ok=exist_ok)
    else:
        path.mkdir(mode=0o700, parents=parents, exist_ok=exist_ok)


def chmod_posix(path: Path, mode: int) -> None:
    if not _WINDOWS:
        os.chmod(path, mode)


@contextmanager
def staging_directory(parent: Path, *, prefix: str) -> Generator[Path, None, None]:
    """Stage beside a destination so publication retains its intended permissions."""
    if not _WINDOWS:
        with tempfile.TemporaryDirectory(dir=parent, prefix=prefix) as temporary:
            yield Path(temporary)
        return
    # mkdtemp passes 0o700, which creates a separate ACL on current CPython.
    # The directory will become the output, so inherit its parent's ACL now.
    staging = parent / f"{prefix}{uuid4().hex}"
    make_private_directory(staging)
    try:
        yield staging
    finally:
        try:
            shutil.rmtree(staging)
        except FileNotFoundError:
            # Successful publication has already renamed the staging directory.
            pass


@contextmanager
def exclusive_file_lock(path: Path) -> Generator[None, None, None]:
    """Hold a nonblocking kernel lock; closing or process exit always releases it."""
    descriptor: int | None = None
    try:
        if is_link_or_reparse(path):
            raise OSError("进程锁文件不能是符号链接或系统重解析点")
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        info = os.fstat(descriptor)
        current = path.lstat()
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or is_link_or_reparse(path)
            or (info.st_dev, info.st_ino) != (current.st_dev, current.st_ino)
        ):
            raise OSError("进程锁文件必须是普通文件")
        if _WINDOWS:
            msvcrt = importlib.import_module("msvcrt")

            # A persistent byte gives every process the same region to lock.
            if info.st_size == 0:
                os.write(descriptor, b"\0")
            os.lseek(descriptor, 0, os.SEEK_SET)
            # The stdlib stubs expose these members only on a Windows type-check
            # host, while this module must also pass checks on POSIX.
            locking = cast(Callable[[int, int, int], None], msvcrt.locking)
            try:
                locking(descriptor, int(msvcrt.LK_NBLCK), 1)
            except PermissionError as exc:
                # The CRT uses EACCES for byte-lock contention after a successful
                # file open. Preserve actual file-access failures separately.
                if exc.errno == errno.EACCES:
                    raise BlockingIOError(errno.EAGAIN, "数据库文件正在使用") from exc
                raise
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


def publish_file(staging: Path, destination: Path) -> None:
    """Publish a completed file without replacing an existing destination."""
    if _WINDOWS:
        os.rename(staging, destination)
    elif not _rename_file_exclusively(staging, destination):
        os.link(staging, destination)


def _rename_file_exclusively(staging: Path, destination: Path) -> bool:
    if sys.platform not in ("darwin", "linux"):
        return False
    libc = ctypes.CDLL(None, use_errno=True)
    source, target = os.fsencode(staging), os.fsencode(destination)
    if b"\0" in source or b"\0" in target:
        raise ValueError("embedded null byte")
    try:
        if sys.platform == "darwin":
            rename = libc.renamex_np
            rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
            result = rename(source, target, _DARWIN_RENAME_EXCL)
        else:
            rename = libc.renameat2
            rename.argtypes = [
                ctypes.c_int,
                ctypes.c_char_p,
                ctypes.c_int,
                ctypes.c_char_p,
                ctypes.c_uint,
            ]
            result = rename(
                _LINUX_AT_FDCWD, source, _LINUX_AT_FDCWD, target, _LINUX_RENAME_NOREPLACE
            )
    except AttributeError:
        return False
    if result == 0:
        return True
    code = ctypes.get_errno()
    if code in (errno.EINVAL, errno.ENOSYS, errno.ENOTSUP, errno.EOPNOTSUPP):
        # An older kernel or filesystem can lack an exclusive rename. Hard
        # links preserve the no-replace guarantee on volumes that support them.
        return False
    raise OSError(code, os.strerror(code), staging, None, destination)


def publish_directory(staging: Path, destination: Path) -> None:
    """Rename a staged tree without replacing an existing destination."""
    if _WINDOWS:
        # Windows rename already refuses every existing destination, even an
        # empty directory. A POSIX-style mkdir claim would prevent publication.
        os.rename(staging, destination)
        return
    make_private_directory(destination)
    try:
        os.rename(staging, destination)
    except BaseException:
        destination.rmdir()
        raise
