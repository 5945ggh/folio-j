"""Offline, versioned private backup packages; never starts application workers."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import importlib.metadata
import os
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import tomllib
from collections.abc import Generator
from contextlib import closing, contextmanager
from pathlib import Path, PurePosixPath
from typing import Literal, NoReturn

from alembic.script import ScriptDirectory
from alembic.util.exc import CommandError
from pydantic import BaseModel, ConfigDict, Field

from app.config import REPO_ROOT, load_settings
from app.epub_storage import decode
from app.services.dictionary_store import DictionaryStore

FIRST_SUPPORTED_REVISION = "0004_translation_reader_removal"
COMPONENTS = {
    "credentials": ("credentials", ".secrets"),
    "dictionary_index": ("dictionary.sqlite3", ".dictionary.sqlite3"),
    "dictionary_library": ("dictionary.sqlite3.library", ".dictionary.sqlite3.library"),
}


class BackupError(ValueError):
    """A backup cannot safely be created or restored."""


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ApplicationVersion(StrictModel):
    version: str
    commit: str | None = None


class DatabaseVersion(StrictModel):
    revision: str = Field(min_length=1)
    epub_contract: Literal["epub-reading-v2"]
    epub_storage_version: Literal[2]


class FileDigest(StrictModel):
    size: int = Field(ge=0)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class Manifest(StrictModel):
    format_version: Literal[1]
    application: ApplicationVersion
    database: DatabaseVersion
    components: dict[str, bool]
    files: dict[str, FileDigest]
    directories: list[str]


def _safe_path(path: Path) -> Path:
    path = path.expanduser().absolute()
    if path.is_symlink():
        raise BackupError(f"不接受符号链接路径：{path}")
    # macOS exposes /tmp and /var through trusted system links.
    return path.parent.resolve() / path.name


def _relative(name: str) -> Path:
    parsed = PurePosixPath(name)
    if (
        not name
        or parsed.is_absolute()
        or any(p in (".", "..") for p in name.split("/"))
        or "\\" in name
    ):
        raise BackupError("备份含不安全相对路径")
    return Path(*parsed.parts)


def _walk_error(error: OSError) -> NoReturn:
    raise error


def _tree(root: Path) -> tuple[set[str], set[str]]:
    files: set[str] = set()
    directories: set[str] = set()
    for current, dirs, names in os.walk(root, followlinks=False, onerror=_walk_error):
        for name in (*dirs, *names):
            item = Path(current) / name
            mode = item.lstat().st_mode
            relative = item.relative_to(root).as_posix()
            if stat.S_ISDIR(mode):
                directories.add(relative)
            elif stat.S_ISREG(mode) and item.stat().st_nlink == 1:
                files.add(relative)
            else:
                raise BackupError(f"不接受链接或特殊文件：{relative}")
    return files, directories


def _digest(path: Path) -> FileDigest:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return FileDigest(size=path.stat().st_size, sha256=digest.hexdigest())


def _connect(path: Path) -> sqlite3.Connection:
    # immutable avoids even creating WAL/SHM files while inspecting a frozen package.
    return sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)


def _check_sqlite(connection: sqlite3.Connection) -> None:
    if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
        raise BackupError("数据库完整性检查失败")
    if connection.execute("PRAGMA foreign_key_check").fetchall():
        raise BackupError("数据库外键检查失败")


def _supported_revisions() -> set[str]:
    """Support the first release baseline and its installed migration descendants."""
    try:
        scripts = ScriptDirectory(str(REPO_ROOT / "backend" / "alembic"))
        return {
            revision.revision
            for revision in scripts.iterate_revisions(
                "heads", FIRST_SUPPORTED_REVISION, inclusive=True
            )
        }
    except CommandError as exc:
        raise BackupError("无法读取程序的数据库迁移链") from exc


def _check_database(path: Path, credentials: Path, expected_revision: str | None = None) -> str:
    with closing(_connect(path)) as connection:
        _check_sqlite(connection)
        versions = connection.execute("SELECT version_num FROM alembic_version").fetchall()
        if len(versions) != 1 or versions[0][0] not in _supported_revisions():
            raise BackupError("不支持此数据库迁移版本，请使用匹配的程序版本")
        revision = str(versions[0][0])
        if expected_revision is not None and revision != expected_revision:
            raise BackupError("数据库实际迁移版本与 manifest 声明不一致")
        for contract, payload, product_sha256, original, source_sha256 in connection.execute(
            "SELECT contract_version, compiled_bundle, product_sha256, original_bytes, "
            "source_sha256 FROM materials "
            "WHERE deleted_at IS NULL"
        ):
            if contract != "epub-reading-v2":
                raise BackupError("不支持此 EPUB 编译包版本")
            try:
                book = decode(payload)
            except ValueError as exc:
                raise BackupError(f"EPUB 编译包无法读取：{exc}") from exc
            if book.contract != contract or book.product_sha256 != product_sha256:
                raise BackupError("EPUB 编译包与材料版本摘要不一致")
            if hashlib.sha256(original).hexdigest() != source_sha256:
                raise BackupError("原 EPUB 字节与来源摘要不一致")
            del book, payload, original
        queries = [
            f"SELECT DISTINCT credential_ref FROM {table} WHERE credential_ref IS NOT NULL"
            for table in ("providers", "runs", "chat_jobs")
        ]
        queries.append(
            "SELECT DISTINCT json_extract(payload, '$.snapshot.credential_ref') "
            "FROM translation_tasks"
        )
        for query in queries:
            for (reference,) in connection.execute(query):
                if reference is None:
                    continue
                if not isinstance(reference, str) or _relative(reference).name != reference:
                    raise BackupError("数据库含不安全凭据引用")
                if not (credentials / reference).is_file():
                    raise BackupError("数据库引用的模型凭据缺失")
        return revision


def _check_dictionaries(index: Path, library: Path) -> None:
    catalog = library / "catalog.sqlite3"
    if library.exists() and not catalog.is_file() and _tree(library)[0]:
        raise BackupError("非空词典目录缺少 catalog.sqlite3")
    if index.exists():
        with closing(_connect(index)) as connection:
            _check_sqlite(connection)
    if not catalog.exists():
        return
    with closing(_connect(catalog)) as connection:
        _check_sqlite(connection)
        ids: set[str] = set()
        for identity, filename in connection.execute(
            "SELECT dictionary_id, filename FROM dictionaries"
        ):
            ids.add(identity)
            if not isinstance(filename, str) or _relative(filename).name != filename:
                raise BackupError("词典目录含不安全引用")
            target = index if filename == "legacy" else library / filename
            if not target.is_file():
                raise BackupError("词典目录引用的索引缺失")
            with closing(_connect(target)) as dictionary:
                _check_sqlite(dictionary)
        for (identity,) in connection.execute("SELECT dictionary_id FROM active"):
            if identity is not None and identity not in ids:
                raise BackupError("当前词典选择引用不存在的词典")


def _application_version() -> ApplicationVersion:
    release = REPO_ROOT / "RELEASE.json"
    if release.exists():
        return ApplicationVersion.model_validate_json(release.read_bytes())
    try:
        version = importlib.metadata.version("folio-j-backend")
    except importlib.metadata.PackageNotFoundError:
        with (REPO_ROOT / "backend" / "pyproject.toml").open("rb") as stream:
            version = str(tomllib.load(stream)["project"]["version"])
    commit = None
    try:
        commit = subprocess.check_output(
            ["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"], stderr=subprocess.DEVNULL, text=True
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        pass
    return ApplicationVersion(version=version, commit=commit)


@contextmanager
def _offline(database: Path) -> Generator[None, None, None]:
    lock = _safe_path(Path(str(database) + ".worker.lock"))
    descriptor = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise BackupError("后台进程锁不是安全的普通文件")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise BackupError("请停止使用此数据库的全部服务后再备份") from exc
        yield
    finally:
        os.close(descriptor)


def _copy(source: Path, target: Path) -> None:
    if source.is_symlink():
        raise BackupError("不接受符号链接文件")
    if source.is_dir():
        files, directories = _tree(source)
        target.mkdir(mode=0o700)
        for name in sorted(directories, key=lambda name: len(Path(name).parts)):
            (target / name).mkdir(mode=0o700)
        for name in sorted(files):
            _copy(source / name, target / name)
    else:
        if not source.is_file() or source.stat().st_nlink != 1:
            raise BackupError("不接受特殊文件或硬链接")
        shutil.copyfile(source, target)
        os.chmod(target, 0o600)


def _snapshot(source: Path, target: Path) -> None:
    if source.is_symlink() or not source.is_file() or source.stat().st_nlink != 1:
        raise BackupError("SQLite 来源不是安全普通文件")
    with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as original:
        with closing(sqlite3.connect(target)) as snapshot:
            original.backup(snapshot)
    os.chmod(target, 0o600)


def _copy_dictionary(source: Path, target: Path) -> None:
    if source.is_file():
        _snapshot(source, target)
        return
    files, directories = _tree(source)
    target.mkdir(mode=0o700)
    for directory in sorted(directories, key=lambda name: len(Path(name).parts)):
        (target / directory).mkdir(mode=0o700)
    for name in sorted(files):
        item = source / name
        if name.endswith(("-wal", "-shm")):
            if not Path(str(item)[:-4]).is_file():
                raise BackupError("词典仅剩 WAL/SHM 配套文件")
            continue
        if item.name.endswith(".sqlite3") or ".sqlite3.deleting-" in item.name:
            _snapshot(item, target / name)
        else:
            _copy(item, target / name)


def _copy_dictionaries(index: Path, library: Path, staging: Path) -> None:
    """Freeze readable catalog references, including an interrupted precommit deletion."""
    target_index = staging / "dictionary.sqlite3"
    target_library = staging / "dictionary.sqlite3.library"
    if index.exists():
        if not index.is_file():
            raise BackupError("旧词典索引不是普通文件")
        _copy_dictionary(index, target_index)
    if library.exists():
        if not library.is_dir():
            raise BackupError("词典 library 不是目录")
        _copy_dictionary(library, target_library)
    catalog = target_library / "catalog.sqlite3"
    if catalog.exists():
        with closing(_connect(catalog)) as connection:
            filenames = [row[0] for row in connection.execute("SELECT filename FROM dictionaries")]
    else:
        # With no catalog the application exposes its original single dictionary.
        filenames = ["legacy"]
    for filename in filenames:
        if not isinstance(filename, str) or _relative(filename).name != filename:
            raise BackupError("词典目录含不安全引用")
        source = index if filename == "legacy" else library / filename
        target = target_index if filename == "legacy" else target_library / filename
        if target.exists():
            continue
        # Reuse the runtime's exact precommit-delete recovery selection. Only
        # catalog references are normalized; committed-deletion orphans stay absent.
        readable = _safe_path(DictionaryStore.readable_index_path(source))
        if readable.exists():
            _snapshot(readable, target)
        elif catalog.exists():
            raise BackupError("词典目录引用的索引缺失")


def _new_destination(destination: Path, sources: list[Path]) -> None:
    for source in sources:
        if (
            destination == source
            or destination.is_relative_to(source)
            or source.is_relative_to(destination)
        ):
            raise BackupError("备份、源数据与恢复目录不能互相嵌套")
    if os.path.lexists(destination):
        raise BackupError("目标必须是不存在的新目录")
    if not destination.parent.is_dir():
        raise BackupError("目标的父目录必须已存在")


def _sync_tree(directory: Path) -> None:
    files, directories = _tree(directory)
    for name in files:
        with (directory / name).open("rb") as stream:
            os.fsync(stream.fileno())
    for path in [*(directory / name for name in directories), directory, directory.parent]:
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


@contextmanager
def _publish(destination: Path) -> Generator[Path, None, None]:
    """Publish only a fully flushed directory; a killed writer leaves no usable target."""
    with tempfile.TemporaryDirectory(
        prefix=".folio-j-backup-", dir=destination.parent
    ) as temporary:
        staging = Path(temporary)
        yield staging
        _sync_tree(staging)
        # mkdir is the exclusive claim: rename must never replace another user's target.
        destination.mkdir(mode=0o700)
        published = False
        try:
            os.rename(staging, destination)
            published = True
            descriptor = os.open(destination.parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        finally:
            if not published:
                destination.rmdir()


def create_backup(destination: Path, database_path: Path | None = None) -> Path:
    """Create a private package while holding the application's exclusive worker lock."""
    destination = _safe_path(destination)
    database = _safe_path(
        database_path if database_path is not None else load_settings().database.path
    )
    if not database.is_file() or database.stat().st_nlink != 1:
        raise BackupError("源数据库不存在或不安全")
    companions = {
        key: _safe_path(Path(str(database) + suffix)) for key, (_, suffix) in COMPONENTS.items()
    }
    _new_destination(destination, [database, *companions.values()])
    with _offline(database), _publish(destination) as staging:
        target = staging / "app.db"
        _snapshot(database, target)
        credentials = companions["credentials"]
        if credentials.exists():
            if not credentials.is_dir():
                raise BackupError("源凭据组件不是目录")
            _copy(credentials, staging / "credentials")
        _copy_dictionaries(
            companions["dictionary_index"], companions["dictionary_library"], staging
        )
        components = {key: (staging / name).exists() for key, (name, _) in COMPONENTS.items()}
        revision = _check_database(target, staging / "credentials")
        _check_dictionaries(staging / "dictionary.sqlite3", staging / "dictionary.sqlite3.library")
        files, directories = _tree(staging)
        manifest = Manifest(
            format_version=1,
            database=DatabaseVersion(
                revision=revision, epub_contract="epub-reading-v2", epub_storage_version=2
            ),
            directories=sorted(directories),
            application=_application_version(),
            components=components,
            files={name: _digest(staging / name) for name in sorted(files)},
        )
        manifest_file = staging / "manifest.json"
        manifest_file.write_text(manifest.model_dump_json(indent=2) + "\n", encoding="utf-8")
        os.chmod(manifest_file, 0o600)

    return destination


def _validate_package(backup: Path) -> Manifest:
    files, directories = _tree(backup)
    manifest = Manifest.model_validate_json((backup / "manifest.json").read_bytes())
    if set(manifest.components) != set(COMPONENTS) or "app.db" not in manifest.files:
        raise BackupError("备份组件清单无效")
    if files != set(manifest.files) | {"manifest.json"}:
        raise BackupError("备份存在未声明或缺失的文件")
    allowed_directories = set(manifest.directories)
    if len(allowed_directories) != len(manifest.directories):
        raise BackupError("备份目录清单重复")
    for name in allowed_directories:
        relative = _relative(name)
        if relative.parts[0] not in ("credentials", "dictionary.sqlite3.library"):
            raise BackupError("备份含未知目录")
        if any(
            parent.as_posix() not in allowed_directories
            for parent in relative.parents
            if parent != Path(".")
        ):
            raise BackupError("备份目录清单缺少父目录")
    for name, expected in manifest.files.items():
        relative = _relative(name)
        top = relative.parts[0]
        if top != "app.db" and top not in {value[0] for value in COMPONENTS.values()}:
            raise BackupError("备份存在未知组件")
        if top in ("app.db", "dictionary.sqlite3") and len(relative.parts) != 1:
            raise BackupError("备份文件结构无效")
        for parent in relative.parents:
            if parent != Path("."):
                if parent.as_posix() not in allowed_directories:
                    raise BackupError("备份文件缺少声明的父目录")
        if _digest(backup / relative) != expected:
            raise BackupError(f"备份文件大小或摘要不匹配：{name}")
    for key, (name, _) in COMPONENTS.items():
        present = (backup / name).exists()
        if manifest.components[key] != present:
            raise BackupError("备份组件有无与清单不一致")
        if present and key != "dictionary_index":
            if not (backup / name).is_dir():
                raise BackupError("备份组件类型错误")
            if name not in allowed_directories:
                raise BackupError("备份组件缺少声明的目录")
    if directories != allowed_directories:
        raise BackupError("备份存在未声明或多余目录")
    _check_database(backup / "app.db", backup / "credentials", manifest.database.revision)
    _check_dictionaries(backup / "dictionary.sqlite3", backup / "dictionary.sqlite3.library")
    return manifest


def restore_backup(backup: Path, destination: Path) -> Path:
    """Validate before creating a new restoration directory; never migrate in place."""
    backup, destination = _safe_path(backup), _safe_path(destination)
    if not backup.is_dir():
        raise BackupError("备份目录不存在")
    _new_destination(destination, [backup])
    manifest = _validate_package(backup)
    with _publish(destination) as staging:
        for name in sorted(manifest.directories, key=lambda name: len(Path(name).parts)):
            _restored_path(staging, name).mkdir(mode=0o700)
        for name, expected in manifest.files.items():
            restored = _restored_path(staging, name)
            _copy(backup / _relative(name), restored)
            if _digest(restored) != expected:
                raise BackupError("恢复期间备份文件发生变化，未保留恢复目标")
    return destination / "app.db"


def _restored_path(directory: Path, name: str) -> Path:
    relative = _relative(name)
    top = relative.parts[0]
    if top == "app.db":
        return directory / "app.db"
    suffix = next(suffix for component, suffix in COMPONENTS.values() if component == top)
    return (directory / ("app.db" + suffix)).joinpath(*relative.parts[1:])


def main() -> int:
    parser = argparse.ArgumentParser(description="Folio-J 停服备份与恢复")
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create")
    create.add_argument("destination", type=Path)
    restore = commands.add_parser("restore")
    restore.add_argument("backup", type=Path)
    restore.add_argument("destination", type=Path)
    arguments = parser.parse_args()
    try:
        result = (
            create_backup(arguments.destination)
            if arguments.command == "create"
            else restore_backup(arguments.backup, arguments.destination)
        )
    except (ValueError, OSError, sqlite3.Error) as exc:
        print(f"备份操作失败：{exc}", file=sys.stderr)
        return 1
    print(f"{'备份' if arguments.command == 'create' else '恢复'}完成：{result}")
    if arguments.command == "create":
        print("此备份可能包含未加密的模型密钥，请私下保管整个目录。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
