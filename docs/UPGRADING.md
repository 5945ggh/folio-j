# 升级与备份

## 更新到新版本

**为避免意外导致数据丢失或损坏，建议每次更新前先备份当前数据库。**

1. **停止并备份**：在运行 Folio-J 的终端按 `Ctrl-C` 停止应用，按下文步骤[制作备份](#制作备份)。
2. **安装新版**：将新版解压到新文件夹。源码版在该目录运行 `just setup` 安装依赖；冻结包无需安装依赖。
3. **核对并启动**：用 `data-path` 核对原库，再启动新版；源码版使用 `just start`，冻结包使用 `./Folio-J start`（Windows 为 `.\Folio-J.exe start`）。路径检查失败时仍可启动进入恢复页，先核对错误和原路径，不要另建空库。属于[当前迁移链](#当前迁移基线)的数据库会在启动前升级。若迁移失败，保留原库和备份，先核对版本。

**关于数据库路径：**
- 默认数据保存在 `~/Folio-J-Data/app.db`，直接移动或更换程序文件夹不会影响数据读取。启动页已记住的位置会继续沿用；没有位置记录时仍兼容 `~/Folio-J-Data/app.toml` 等旧配置。
- **如果新版显示的路径与原来不同**：先在旧版运行 `data-path` 记下原库绝对路径。停止服务后，用新版 `start --choose-data` 打开选择页，选择“打开已有数据”并填写原数据库文件或所在目录；进入设置核对实际路径。旧版没有选择页时沿用其配置方法。也可先把整套备份恢复到长期保留的位置，再选择恢复库。不要只复制主数据库而遗漏词典或凭据。

## 制作备份

要做备份时，先停止 Folio-J，在程序目录中运行 `just data-path`。确认显示的是你要备份的数据库后，运行下面的命令。

```sh
just backup "$HOME/folio-backup-01"
```

如果启动应用时用 `FOLIO_J_DATABASE_PATH` 指定了数据库，查看路径和备份时都要带上它。例如，你的数据库在 `/Volumes/Study/Folio-J/app.db`，就先用 `FOLIO_J_DATABASE_PATH="/Volumes/Study/Folio-J/app.db" just data-path` 核对，再运行下面的命令。

```sh
FOLIO_J_DATABASE_PATH="/Volumes/Study/Folio-J/app.db" just backup "$HOME/folio-backup-01"
```

PowerShell 中先设置环境变量，再调用相同的命令。备份结束后删除该变量；下例路径请替换成实际源库。

```powershell
$env:FOLIO_J_DATABASE_PATH = "D:/学习资料/app.db"
just data-path
just backup "$HOME/folio-backup-01"
Remove-Item Env:FOLIO_J_DATABASE_PATH
```

这条命令会在你的主目录下创建 `folio-backup-01` 文件夹并存入备份。**每次备份都需要指定一个新的文件夹名称。** 如果想直接备份到移动硬盘，请先接好硬盘，再将上述路径替换为移动硬盘下的新文件夹路径。

<a id="数据与凭据"></a>

**备份包含与不包含的内容：**

* **包含**：所有书籍、阅读进度、书签、学习片段、讲解、讨论、已保存的译文，以及已安装的词典。**若配置过模型服务，备份中还可能包含未加密的 API 密钥**，请妥善保存在私人目录，切勿直接分享给他人。
* **不包含**：旧应用配置文件 `~/Folio-J-Data/app.toml`（需另行保存）、本机记住的数据位置，以及阅读配色、朗读发音人等保存在浏览器本地的偏好设置。恢复到新位置或新电脑后，通过启动选择页打开恢复库。

Windows 使用所在目录继承的访问权限，不额外设置 ACL。请把含凭据的学习库和备份放在本人管理的私有目录内，避免放入共享目录。备份仍会刷写文件内容，但 Windows 未提供与 POSIX 目录刷盘等价的保证；断电后的目录元数据耐久性尚未验证。

<a id="旧开发数据库与备份"></a>
<a id="epub-存储格式与开发库重建"></a>

## 当前迁移基线

- **已有数据库升级**：当前 Alembic 迁移链从 `0001_schema_baseline` 到 `0004_translation_reader_removal`。版本属于这条链时，用旧版备份后再用新版启动。
- **原生备份恢复**：`just restore` 接受含 `manifest.json` 的 v1 备份。数据库须从 `0004_translation_reader_removal` 起且版本在当前程序已知的迁移链内；仍在使用的 EPUB 须为 `epub-reading-v2`、编译包为 FJEPUB v2。恢复先还原备份时的版本，后续升级由启动时的迁移完成。
- **早期开发库与手工备份**：含 `backup-info.txt` 的旧备份应使用其中记录的程序版本及当时的恢复步骤。早期迁移链（如 `0001_initial`）及旧 EPUB 编译包也需使用匹配版本。修改版本标签不能转换数据；重新导入 EPUB 也不能恢复原来的书签、片段出处与讲解关联。

## 恢复备份、回退版本或迁移到新电脑

恢复操作不会覆盖或破坏你当前的数据库，而是将备份还原到一个**全新的文件夹**中，再通过修改配置指向这个新文件夹。因此无论是找回误删资料、升级失败回退，还是换新电脑，操作逻辑完全一致：

### 通用恢复步骤（以换新电脑或找回数据为例）

1. **准备环境与备份文件**：若应用正在运行，先按 `Ctrl-C` 停止。如果是换到新电脑，先在新电脑上解压 Folio-J 并运行 `just setup`，再把旧电脑上的备份文件夹（如 `folio-backup-01`）复制到新电脑的主目录。
2. **执行恢复命令**：在 Folio-J 程序目录中运行以下命令，将备份还原到一个新的数据文件夹（如 `~/folio-restored-01`，若重名请换一个新名字）：

   ```sh
   just restore "$HOME/folio-backup-01" "$HOME/folio-restored-01"
   ```
3. **选择恢复库**：运行 `uv run --project backend python -m app.launcher start --choose-data`，在选择页填写新恢复目录，点击“打开已有数据”。冻结包使用 `./Folio-J start --choose-data`，Windows 使用 `.\Folio-J.exe start --choose-data`。如果使用了 `FOLIO_J_DATABASE_PATH`，先移除或修改该变量；它仍具有最高优先级。打开已有库不会搬迁或覆盖原库。
4. **确认运行位置**：进入“设置 → 数据位置”，核对数据库指向新恢复目录中的 `app.db`，再检查书架、学习记录和词典。位置会被记住，之后正常启动即可。

旧版程序没有选择页时，沿用旧版说明修改配置或用 `FOLIO_J_DATABASE_PATH` 指向恢复库；不要让旧程序直接读取已被新版升级的库。

### 升级失败时如何退回旧版

如果新版无法正常启动、想先退回旧版继续看书：

1. 如果新版仍在运行，先按 `Ctrl-C` 停止。进入**升级前能正常使用的旧版程序文件夹**（若已删除，请重新解压对应旧版本并运行 `just setup`）。
2. 在旧版程序目录中完成[通用恢复步骤](#通用恢复步骤以换新电脑或找回数据为例)的第 2–4 步，恢复时选择**升级前制作的备份**即可。

## 没有安装 just 时

若未安装 `just`，可在程序根目录用 `uv run --project backend --no-dev python -m app.launcher data-path` 核对源库，再运行对应的备份或恢复命令。平时若用 `FOLIO_J_DATABASE_PATH` 临时指定学习库，核对和备份时同样要带上它。完整启动步骤见[快速开始](../README.md#快速开始)。

```sh
# 制作备份
uv run --project backend --no-dev python -m app.backup create "$HOME/folio-backup-01"

# 从已有备份恢复
uv run --project backend --no-dev python -m app.backup restore "$HOME/folio-backup-01" "$HOME/folio-restored-01"
```
