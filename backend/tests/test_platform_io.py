"""Kernel locks protect separate processes and recover after an abrupt exit."""

import os
import stat
import subprocess
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

from app import platform_io
from app.platform_io import FileLockError, exclusive_file_lock, fsync_directory, is_link_or_reparse


def test_exclusive_lock_refuses_another_open_and_releases_after_exception(tmp_path: Path) -> None:
    path = tmp_path / "worker.lock"
    with pytest.raises(RuntimeError, match="injected"):
        with exclusive_file_lock(path):
            with pytest.raises(FileLockError):
                with exclusive_file_lock(path):
                    pytest.fail("a second open acquired the same lock")
            raise RuntimeError("injected")
    with exclusive_file_lock(path):
        assert path.is_file()


def test_lock_released_when_holding_process_is_killed(tmp_path: Path) -> None:
    path = tmp_path / "worker.lock"
    script = (
        "import sys\n"
        "from pathlib import Path\n"
        "from app.platform_io import exclusive_file_lock\n"
        "with exclusive_file_lock(Path(sys.argv[1])):\n"
        "    print('locked', flush=True)\n"
        "    sys.stdin.read()\n"
    )
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
    process = subprocess.Popen(
        [sys.executable, "-c", script, str(path)],
        env=environment,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert process.stdout is not None
        assert process.stdout.readline().strip() == "locked"
        with pytest.raises(FileLockError):
            with exclusive_file_lock(path):
                pytest.fail("a second process acquired the same lock")
    finally:
        process.kill()
        process.communicate(timeout=10)
    with exclusive_file_lock(path):
        assert path.exists()  # The persistent file is not a stale ownership marker.


def test_lock_rejects_hard_links(tmp_path: Path) -> None:
    original, linked = tmp_path / "original", tmp_path / "linked"
    original.write_bytes(b"unchanged")
    linked.hardlink_to(original)
    with pytest.raises(FileLockError):
        with exclusive_file_lock(linked):
            pytest.fail("hard-linked lock accepted")
    assert original.read_bytes() == b"unchanged"


def test_reparse_point_is_detected_and_cannot_be_used_as_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "junction"
    info = SimpleNamespace(
        st_mode=stat.S_IFDIR, st_file_attributes=stat.FILE_ATTRIBUTE_REPARSE_POINT
    )

    def reparse_stat(_path: Path) -> SimpleNamespace:
        return info

    monkeypatch.setattr(Path, "lstat", reparse_stat)
    assert is_link_or_reparse(path)
    with pytest.raises(FileLockError, match="reparse point"):
        with exclusive_file_lock(path):
            pytest.fail("reparse lock accepted")


def test_windows_directory_flush_does_not_open_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(platform_io, "_WINDOWS", True)

    def forbidden_open(*_args: object, **_kwargs: object) -> int:
        pytest.fail("Windows directory flush attempted os.open")

    monkeypatch.setattr(os, "open", forbidden_open)
    fsync_directory(tmp_path)


def test_windows_lock_locks_same_byte_and_closes_descriptor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "worker.lock"
    descriptors: list[int] = []

    def locking(descriptor: int, mode: int, count: int) -> None:
        assert mode == 2
        assert count == 1
        assert os.lseek(descriptor, 0, os.SEEK_CUR) == 0
        assert os.read(descriptor, 1) == b"\0"
        descriptors.append(descriptor)

    msvcrt = ModuleType("msvcrt")
    msvcrt.__dict__.update(locking=locking, LK_NBLCK=2)
    monkeypatch.setitem(sys.modules, "msvcrt", msvcrt)
    monkeypatch.setattr(platform_io, "_WINDOWS", True)
    with exclusive_file_lock(path):
        assert len(descriptors) == 1
    with pytest.raises(OSError):
        os.fstat(descriptors[0])
