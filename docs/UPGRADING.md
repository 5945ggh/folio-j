# 升级与备份

## 更新到新版本

**为避免意外导致数据丢失或损坏，建议每次更新前先备份当前数据库。**

1. **停止并备份**：在运行 Folio-J 的终端按 `Ctrl-C` 停止应用，按下文步骤[制作备份](#制作备份)。
2. **安装新版**：将新版解压到新文件夹。源码版在该目录运行 `just setup` 安装依赖；免安装目录包无需安装依赖。
3. **核对并启动**：先用 `data-path` 核对数据库路径，确认无误后再启动新版（属于[当前迁移基线](#当前迁移基线)的数据库会在启动时自动升级）：
   - **源码版**：依次运行 `just data-path` 和 `just start`
   - **目录包**：依次运行 `./Folio-J data-path` 和 `./Folio-J start`（Windows PowerShell 使用 `.\Folio-J.exe`）

**关于数据库路径**：

- 学习数据默认保存在 `~/Folio-J-Data/app.db`，已记住的数据位置在更换或移动程序文件夹后会自动沿用。
- **如果新版显示的路径与原来不同**（例如旧版 Windows 曾通过注册表记录自定义路径）：先停止服务，再用 `--choose-data` 参数打开选择页，点击「打开已有数据」并填入原数据库文件或所在目录即可（详见[应用配置](USAGE.md#配置优先级与高级选项)）。切勿只手动复制单个 `app.db` 文件而遗漏同目录的词典或凭据文件夹。

## 制作备份

制作备份前，请先按 `Ctrl-C` 停止正在运行的 Folio-J，核对数据库路径后再执行备份。**每次备份都需要指定一个尚不存在的新文件夹路径**（若备份到移动硬盘，请替换为移动硬盘下的新文件夹路径）：

```sh
# 源码版
just data-path
just backup "$HOME/folio-backup-01"

# macOS / Linux 免安装目录包
./Folio-J data-path
./Folio-J backup "$HOME/folio-backup-01"
```

```powershell
# Windows 免安装目录包（PowerShell）
.\Folio-J.exe data-path
.\Folio-J.exe backup "$HOME/folio-backup-01"
```

<details>
<summary>使用环境变量 FOLIO_J_DATABASE_PATH 指定数据库时的备份方式</summary>

如果平时启动应用时通过环境变量 `FOLIO_J_DATABASE_PATH` 指定了数据库位置，核对路径与备份时也需要带上同一变量（目录包将 `just` 替换为 `./Folio-J` 或 `.\Folio-J.exe`）：

```sh
# macOS / Linux
FOLIO_J_DATABASE_PATH="/Volumes/Study/Folio-J/app.db" just data-path
FOLIO_J_DATABASE_PATH="/Volumes/Study/Folio-J/app.db" just backup "$HOME/folio-backup-01"
```

```powershell
# Windows PowerShell
$env:FOLIO_J_DATABASE_PATH = "D:/学习资料/app.db"
.\Folio-J.exe data-path
.\Folio-J.exe backup "$HOME/folio-backup-01"
Remove-Item Env:FOLIO_J_DATABASE_PATH
```

</details>

<a id="数据与凭据"></a>

**备份包含与不包含的内容**：

- **包含**：所有书籍、阅读进度、书签、学习片段、讲解、讨论、已保存的译文，以及已安装的词典。**若配置过模型服务，备份中可能包含未加密的 API 密钥**，请妥善保存在个人私有目录，切勿直接分享给他人。
- **不包含**：`~/Folio-J-Data/app.toml` 配置文件（如需保留请另行复制）、本机记住的数据位置记录，以及阅读纸面、朗读发音人等保存在浏览器本地的偏好设置。

## 恢复备份、回退版本或迁移到新电脑

恢复操作不会覆盖或破坏你当前的数据库，而是将备份还原到一个**全新的文件夹**中，再通过启动选择页打开恢复库。因此无论是找回误删资料、升级失败回退，还是迁移到新电脑，操作步骤完全一致。

### 通用恢复步骤（以换新电脑或找回数据为例）

1. **准备环境与备份文件**：若应用正在运行，先按 `Ctrl-C` 停止。如果是换到新电脑，先在新电脑上解压 Folio-J（源码版运行 `just setup` 安装依赖，免安装目录包直接保留完整目录即可），再把旧电脑上的备份文件夹（如 `folio-backup-01`）完整复制到新电脑。
2. **执行恢复命令**：在程序目录中运行以下命令，将备份还原到一个尚不存在的新数据文件夹（如 `~/folio-restored-01`）：

   ```sh
   # 源码版
   just restore "$HOME/folio-backup-01" "$HOME/folio-restored-01"

   # macOS / Linux 免安装目录包
   ./Folio-J restore "$HOME/folio-backup-01" "$HOME/folio-restored-01"
   ```

   ```powershell
   # Windows 免安装目录包（PowerShell）
   .\Folio-J.exe restore "$HOME/folio-backup-01" "$HOME/folio-restored-01"
   ```

3. **选择恢复库**：运行以下命令打开数据位置选择页，选择「打开已有数据」并填入刚恢复的目录（若此前设置了环境变量 `FOLIO_J_DATABASE_PATH`，请先移除该变量）：

   ```sh
   # 源码版
   pnpm --dir frontend build
   uv run --project backend python -m app.launcher start --choose-data

   # macOS / Linux 免安装目录包（Windows 使用 .\Folio-J.exe start --choose-data）
   ./Folio-J start --choose-data
   ```

4. **确认运行位置**：进入应用后，在「设置 → 数据位置」核对当前路径已指向新恢复目录中的 `app.db`，再检查书架、学习记录和词典。位置会被自动记住，之后正常启动即可。

### 升级失败时如何退回旧版

如果新版无法正常启动、想先退回旧版继续看书：

1. 若新版仍在运行，先按 `Ctrl-C` 停止，进入**升级前能正常使用的旧版程序文件夹**（若已删除，请重新解压对应旧版本；源码版按旧版说明安装依赖）。
2. 按旧版随包的「升级与备份」指南，将**升级前制作的备份**恢复到新目录，并切换到恢复库。beta.1／beta.2 通过 `app.toml` 配置数据路径，没有新版的数据位置选择页。不要让旧版程序直接读取已被新版升级过的数据库文件。

## 源码版未安装 just 时的等价命令

如果使用源码版且未安装 `just`，可在程序根目录直接运行以下命令进行路径核对、备份与恢复：

```sh
# 1. 查看当前数据库路径
uv run --project backend --no-dev python -m app.launcher data-path

# 2. 制作备份
uv run --project backend --no-dev python -m app.backup create "$HOME/folio-backup-01"

# 3. 从已有备份恢复到新目录
uv run --project backend --no-dev python -m app.backup restore "$HOME/folio-backup-01" "$HOME/folio-restored-01"
```

<a id="旧开发数据库与备份"></a>
<a id="epub-存储格式与开发库重建"></a>

## 当前迁移基线

- **受支持的数据库升级范围**：当前 Alembic 迁移链为 `0001_schema_baseline` 至 `0004_translation_reader_removal`。属于该迁移链的数据库可在备份后直接用新版启动升级。
- **受支持的备份恢复范围**：`restore` 命令支持含 `manifest.json` 的 v1 原生备份（数据库版本需在 `0004_translation_reader_removal` 及之后的已知迁移链内，且托管 EPUB 编译包为 `epub-reading-v2` / `FJEPUB v2`）。恢复时会先还原备份当时的版本，随后在启动时自动完成后续迁移。
- **早期开发库与历史备份**：早于上述基线的开发期数据库（如 `0001_initial`）、旧版 EPUB 编译包或含 `backup-info.txt` 的早期手工备份，不支持直接自动转换，请使用当时对应的程序版本打开；仅重新导入同名 EPUB 不会恢复原有的书签、片段出处与讲解关联。
