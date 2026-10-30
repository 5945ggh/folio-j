# 升级与备份

已有学习数据时，在更新代码并运行 `just dev`、`just start` 或 `just migrate` 前阅读本文。这些命令会执行数据库迁移，应用不会自动删库。首次从空库启动见[项目首页](../README.md#快速开始)。

## 数据与凭据

默认数据库为仓库下的 `data/app.db`。`config/app.toml` 可以修改路径，环境变量 `FOLIO_J_DATABASE_PATH` 会覆盖配置；相对路径以仓库根目录为基准。迁移与应用读取同一路径，具体配置见[使用指南](USAGE.md#应用配置)。

模型密钥保存在数据库旁的 `<数据库文件名>.secrets/` 私有目录，默认对应 `data/app.db.secrets/`。目录权限为 `0700`，文件权限为 `0600`；这是文件权限保护，尚未加密。旧凭据暂保留以支撑已接受请求的固定引用，不应仅按当前设置页清理该目录。

升级前停止使用目标库的服务，制作 SQLite 一致性备份，并同时备份对应凭据目录。数据库使用 WAL 模式，不要在服务仍写入时只复制主数据库文件。恢复时保持数据库与凭据目录配套；改名或换路径时，凭据目录也须对应新的数据库文件名。

### 制作备份

先在运行服务的终端按 `Ctrl-C`，确认所有使用该库的实例均已退出。在仓库根目录执行以下示例，把参数换成仓库外一个尚不存在的绝对目录；如平时设置了 `FOLIO_J_DATABASE_PATH`，备份时也使用同一值。脚本读取当前应用配置，以只读连接调用 SQLite 的备份 API，不复制源库的 WAL／SHM 文件。

```sh
uv run --project backend python - /absolute/path/to/new-backup <<'PY'
import os
import shutil
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path

from app.config import load_settings

source = load_settings().database.path.resolve()
destination = Path(sys.argv[1]).expanduser()
if not destination.is_absolute() or not source.is_file():
    raise SystemExit("请使用绝对备份路径，并确认源数据库已存在。")
revision = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
destination.mkdir(mode=0o700)  # 已有目录会报错，不覆盖旧备份。
with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as original:
    with closing(sqlite3.connect(destination / "database.sqlite3")) as snapshot:
        original.backup(snapshot)
        if snapshot.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise SystemExit("备份完整性检查失败，请保留源库并检查错误。")
os.chmod(destination / "database.sqlite3", 0o600)
credentials = source.with_name(source.name + ".secrets")
if credentials.exists():
    shutil.copytree(credentials, destination / "credentials")
    for item in (destination / "credentials").rglob("*"):
        os.chmod(item, 0o700 if item.is_dir() else 0o600)
    os.chmod(destination / "credentials", 0o700)
(destination / "backup-info.txt").write_text(
    f"code_revision={revision}\nsource_database={source}\n", encoding="utf-8"
)
print(f"备份完成：{destination}")
PY
```

只有输出“备份完成”才表示数据库、凭据复制及检查均已完成；中途失败时保留源库，换一个新目录重试。备份目录含未加密密钥，应私下保管。`backup-info.txt` 记录提交号与源库路径，不归档代码或本地改动；同时保留对应代码与未提交修改，恢复历史备份时使用匹配版本。

### 恢复到独立路径

先准备与备份匹配的代码和依赖，停止服务，再把下面两个参数改为备份目录和一个全新的数据库绝对路径。脚本拒绝覆盖已有数据库、凭据目录及残留 WAL／SHM／进程锁文件，原库保持可用。不要通过删除现存 WAL／SHM 来绕过检查，另选新路径。

```sh
uv run --project backend python - /absolute/path/to/new-backup /absolute/path/to/restored/app.db <<'PY'
import os
import shutil
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

backup = Path(sys.argv[1]).expanduser()
target = Path(sys.argv[2]).expanduser()
if not backup.is_absolute() or not target.is_absolute():
    raise SystemExit("备份目录与恢复路径都必须是绝对路径。")
source = backup / "database.sqlite3"
if not source.is_file() or not (backup / "backup-info.txt").is_file():
    raise SystemExit("备份不完整，请检查数据库与备份说明。")
reserved = [Path(str(target) + suffix) for suffix in ("", "-wal", "-shm", ".secrets", ".worker.lock")]
if any(item.exists() or item.is_symlink() for item in reserved):
    raise SystemExit("恢复目标或配套文件已存在，请选择全新路径。")
with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)) as snapshot:
    if snapshot.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
        raise SystemExit("备份完整性检查失败，未恢复。")
target.parent.mkdir(parents=True, exist_ok=True)
with source.open("rb") as original, target.open("xb") as restored:
    os.chmod(target, 0o600)
    shutil.copyfileobj(original, restored)
if (backup / "credentials").exists():
    credentials = Path(str(target) + ".secrets")
    shutil.copytree(backup / "credentials", credentials)
    for item in credentials.rglob("*"):
        os.chmod(item, 0o700 if item.is_dir() else 0o600)
    os.chmod(credentials, 0o700)
print(f"恢复完成：{target}")
PY
```

若恢复中途失败，保留备份与原库，排查后换一个新目标重试。完成后，以同一目标路径启动匹配代码，例如 `FOLIO_J_DATABASE_PATH=/absolute/path/to/restored/app.db just start`；确认来源、阅读记录、讲解和模型设置可读后，再决定是否用配置文件固定此路径。后续每次启动和迁移都须使用相同路径，避免误开默认数据库。后台任务在恢复后按正常重启规则处理中断状态，不自动重放模型请求。

## EPUB 存储格式与开发库重建

应用只读取 `FJEPUB` 版本字节 `2` 的图片池编译包，对应逻辑契约 `epub-reading-v2`。最终产物仅保留章节 HTML，完整资源 HTML 只在编译时临时使用；资源正文、样式及定位信息继续保留。v1 图片池包和旧裸 zlib 书包均不支持，不提供旧格式转换命令。无图和小图书籍同样使用这一格式；原 EPUB 不变，新产物摘要按新契约计算，重新导入创建新材料与版本。

旧开发数据可丢弃时，先停止使用目标库的应用并保留原始 EPUB，再显式删除已确认的数据库及其 `-wal`、`-shm` 文件；配套凭据目录随已放弃的模型设置一并清理。随后运行 `just migrate` 从空库建立当前 schema，重新导入 EPUB 并配置模型。重新导入会创建新的材料、版本及阅读位置；讲解、讨论、译文与其他学习数据不会由原 EPUB 恢复。应用启动和日常迁移不会自动删库。

已有历史备份保留对应的历史格式，需要使用生成备份时的代码读取；不能仅通过 Alembic stamp 使旧编译包变成新格式。数据需要保留时，继续使用对应代码和配套凭据，不直接执行开发库重建。当前格式及本轮验证见[存储验收](handovers/archived/EPUB_STORAGE_ACCEPTANCE.md)。

## 当前迁移基线

从空库运行以下命令即可建立完整 schema 并应用后续迁移：

```sh
just migrate
```

当前迁移链为 `0001_schema_baseline` → `0002_context_copy_settings` → `0003_material_bookmarks`：初始基线建立原有 28 表，第二份脚本新增复制设置表，第三份新增位置书签表，最终共 30 张业务表。已有库仅执行尚未应用的增量脚本，原有材料、学习记录与设置保持；重复运行不会重建表或重置配置。旧浏览器复制偏好不导入，未保存过数据库配置时使用默认值。书签和备注写入数据库，备份时随库一并保留。

按前文停止服务并完成一致性备份后，运行 `just migrate` 升级；`just dev` 和 `just start` 也会先执行相同迁移。无需额外手工 SQL 或 stamp。原有开发期六个 revision 已合并，不再支持从它们逐步升级；基线编号与旧 `0001_initial` 不同，避免旧库被误认为已达到当前结构。

从本基线开始保存需保留的数据后，备份并运行相同命令应用后续增量迁移。显式降级到 base 会删除全部应用表；迁移事务、外键校验及边界见[架构](ARCHITECTURE.md#3-领域模型)，本轮结构等价与验证见[迁移验收](handovers/archived/DATABASE_MIGRATION_ACCEPTANCE.md)。

第一版发布前且数据可丢弃时，允许重整初始迁移；开始保存需保留的日常数据或发布第一版后，采用严格增量迁移。工程约束见 [AGENTS.md](../AGENTS.md#硬性规则)。

## 旧开发数据库与备份

开发期迁移整理与显式版本对齐的历史过程见[早期基线验收](handovers/archived/DATABASE_BASELINE_ACCEPTANCE.md)和[当前基线验收](handovers/archived/DATABASE_MIGRATION_ACCEPTANCE.md)。

旧 `0001_initial` 至 `0006_translations` 版本标签会明确报未找到 revision，不会自动重建或修改数据。可丢弃旧开发库时按前节显式重建；需要保留数据时使用对应历史代码和配套备份。
