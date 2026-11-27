"""Kernel locks protect separate processes and recover after an abrupt exit."""

import errno
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
    with pytest.raises(FileLockError, match="符号链接或系统重解析点"):
        with exclusive_file_lock(path):
            pytest.fail("reparse lock accepted")


@pytest.mark.parametrize(
    ("tag", "redirects"),
    [
        (0xA000000C, True),  # IO_REPARSE_TAG_SYMLINK
        (0xA0000003, True),  # IO_REPARSE_TAG_MOUNT_POINT
        (0x8000101A, False),  # IO_REPARSE_TAG_CLOUD_1
        (0x80000017, False),  # IO_REPARSE_TAG_WOF
        (0, True),  # Attribute present but the tag was unavailable.
    ],
)
def test_windows_reparse_tags_only_reject_redirecting_or_unknown_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, tag: int, redirects: bool
) -> None:
    path = tmp_path / "worker.lock"
    path.touch()
    lstat = Path.lstat

    def tagged_lstat(candidate: Path) -> os.stat_result | SimpleNamespace:
        info = lstat(candidate)
        if candidate != path:
            return info
        return SimpleNamespace(
            st_mode=info.st_mode,
            st_dev=info.st_dev,
            st_ino=info.st_ino,
            st_file_attributes=stat.FILE_ATTRIBUTE_REPARSE_POINT,
            st_reparse_tag=tag,
        )

    monkeypatch.setattr(Path, "lstat", tagged_lstat)
    assert is_link_or_reparse(path) == redirects
    if redirects:
        with pytest.raises(FileLockError, match="符号链接或系统重解析点"):
            with exclusive_file_lock(path):
                pytest.fail("redirected lock was accepted")
    else:
        with exclusive_file_lock(path):
            assert path.is_file()


def test_windows_directory_flush_does_not_open_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(platform_io, "_WINDOWS", True)

    def forbidden_open(*_args: object, **_kwargs: object) -> int:
        pytest.fail("Windows directory flush attempted os.open")

    monkeypatch.setattr(os, "open", forbidden_open)
    fsync_directory(tmp_path)


@pytest.mark.parametrize("windows", [False, True])
def test_private_mode_applies_only_on_posix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, windows: bool
) -> None:
    directory = tmp_path / "private"
    credential = directory / "key"
    mkdir_calls: list[tuple[Path, int | None]] = []
    chmod_calls: list[tuple[Path, int]] = []

    def mkdir(path: Path, *, mode: int | None = None, parents: bool, exist_ok: bool) -> None:
        assert parents and exist_ok
        mkdir_calls.append((path, mode))

    def chmod(path: Path, mode: int) -> None:
        chmod_calls.append((path, mode))

    monkeypatch.setattr(platform_io, "_WINDOWS", windows)
    monkeypatch.setattr(Path, "mkdir", mkdir)
    monkeypatch.setattr(os, "chmod", chmod)
    platform_io.make_private_directory(directory, parents=True, exist_ok=True)
    platform_io.chmod_posix(directory, 0o700)
    platform_io.chmod_posix(credential, 0o600)
    assert mkdir_calls == [(directory, None if windows else 0o700)]
    assert chmod_calls == ([] if windows else [(directory, 0o700), (credential, 0o600)])


@pytest.mark.skipif(
    sys.platform not in ("darwin", "linux", "win32"), reason="native exclusive rename"
)
def test_publish_file_renames_without_hard_links_or_overwriting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    staging = tmp_path / "ステージ"
    destination = tmp_path / "完成"
    staging.write_bytes(b"new")
    destination.write_bytes(b"existing")

    def no_hard_links(*_args: object, **_kwargs: object) -> None:
        pytest.fail("native publication attempted a hard link")

    monkeypatch.setattr(os, "link", no_hard_links)
    with pytest.raises(FileExistsError):
        platform_io.publish_file(staging, destination)
    assert destination.read_bytes() == b"existing"
    assert staging.read_bytes() == b"new"
    destination.unlink()

    platform_io.publish_file(staging, destination)
    assert destination.read_bytes() == b"new"
    assert destination.stat().st_nlink == 1
    assert not staging.exists()


@pytest.mark.parametrize("contended", [False, True])
def test_windows_lock_locks_same_byte_and_closes_descriptor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, contended: bool
) -> None:
    path = tmp_path / "worker.lock"
    descriptors: list[int] = []

    def locking(descriptor: int, mode: int, count: int) -> None:
        assert mode == 2
        assert count == 1
        assert os.lseek(descriptor, 0, os.SEEK_CUR) == 0
        assert os.read(descriptor, 1) == b"\0"
        descriptors.append(descriptor)
        if contended:
            raise PermissionError(errno.EACCES, "locking denied")

    msvcrt = ModuleType("msvcrt")
    msvcrt.__dict__.update(locking=locking, LK_NBLCK=2)
    monkeypatch.setitem(sys.modules, "msvcrt", msvcrt)
    monkeypatch.setattr(platform_io, "_WINDOWS", True)
    if contended:
        with pytest.raises(FileLockError) as rejected:
            with exclusive_file_lock(path):
                pytest.fail("a contended lock was acquired")
        # Windows reports EACCES for a held byte lock; callers must not confuse
        # that with permission to open the file or recommend moving the library.
        assert isinstance(rejected.value.__cause__, BlockingIOError)
    else:
        with exclusive_file_lock(path):
            assert len(descriptors) == 1
    with pytest.raises(OSError):
        os.fstat(descriptors[0])
