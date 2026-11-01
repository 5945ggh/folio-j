# 升级与备份

<a id="当前迁移基线"></a>

## 更新到新版本

**为避免意外导致数据丢失或损坏，建议每次更新前先备份当前数据库。**

1. **停止并备份**：在运行 Folio-J 的终端按 `Ctrl-C` 停止应用，按下文步骤[制作备份](#制作备份)。
2. **安装新版**：将新版解压到一个新文件夹。在终端进入该文件夹，运行 `just setup` 安装依赖，终端末尾会显示新版即将使用的数据库路径。
3. **核对并启动**：确认显示的路径指向你原来的数据库，再运行 `just start`。新版启动时会自动完成所需的数据库迁移，一般无需额外处理。若启动遇到问题，可尝试借助 coding agent 排查或联系开发人员，此时提前备份的旧数据库会非常有用。

**关于数据库路径：**
- 默认数据保存在 `~/Folio-J-Data/app.db`，直接移动或更换程序文件夹不会影响数据读取。若你已在 `~/Folio-J-Data/app.toml` 中自定义过路径，新版也会自动沿用。
- **如果新版显示的路径与原来不同**（例如旧版使用的是程序目录内的相对路径）：先回到**旧版程序目录**运行 `just data-path`，记下原数据库的完整绝对路径（含文件名）；接着打开 `~/Folio-J-Data/app.toml`，在 `[database]` 下将 `path` 设为该路径；最后到**新版程序目录**运行 `just data-path` 核对无误即可。当然，为了避免后续维护的麻烦，我们鼓励在这种情形下，将数据库备份出来，并恢复到一个长期稳定的位置，再对应调整 `app.toml` 中的路径。详情见[使用指南 - 应用配置](USAGE.md#应用配置)。


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
* **不包含**：应用配置文件 `~/Folio-J-Data/app.toml`（需另行保存），以及阅读配色、朗读发音人等保存在浏览器本地的偏好设置。

Windows 使用所在目录继承的访问权限，不额外设置 ACL。请把含凭据的学习库和备份放在自己的用户目录内。备份仍会刷写文件内容，但 Windows 未提供与 POSIX 目录刷盘等价的保证；断电后的目录元数据耐久性尚未验证。

<a id="旧开发数据库与备份"></a> <a id="epub-存储格式与开发库重建"></a>


## 恢复备份、回退版本或迁移到新电脑

恢复操作不会覆盖或破坏你当前的数据库，而是将备份还原到一个**全新的文件夹**中，再通过修改配置指向这个新文件夹。因此无论是找回误删资料、升级失败回退，还是换新电脑，操作逻辑完全一致：

### 通用恢复步骤（以换新电脑或找回数据为例）

1. **准备环境与备份文件**：若应用正在运行，先按 `Ctrl-C` 停止。如果是换到新电脑，先在新电脑上解压 Folio-J 并运行 `just setup`，再把旧电脑上的备份文件夹（如 `folio-backup-01`）复制到新电脑的主目录。
2. **执行恢复命令**：在 Folio-J 程序目录中运行以下命令，将备份还原到一个新的数据文件夹（如 `~/folio-restored-01`，若重名请换一个新名字）：

   ```sh
   just restore "$HOME/folio-backup-01" "$HOME/folio-restored-01"
   ```
3. **切换数据库路径**：复制恢复成功时终端显示的完整 `app.db` 路径。打开或新建 `~/Folio-J-Data/app.toml`（文件夹不存在时先创建），将路径填入 `[database]` 下的 `path`。下面以第 2 步的示例文件夹为例；如果你换了名字，请使用终端显示的实际路径。

   ```toml
   [database]
   path = "~/folio-restored-01/app.db"
   ```
   Windows 也可填写 `C:/Users/你的用户名/folio-restored-01/app.db`。使用反斜杠时应改用 TOML 单引号，具体见[自定义数据位置](USAGE.md#自定义数据位置与端口)。
4. **确认并启动**：运行 `just data-path`。显示的路径与第 2 步恢复成功时的路径一致后，运行 `just start` 打开恢复后的书架。

### 升级失败时如何退回旧版

如果新版无法正常启动、想先退回旧版继续看书：

1. 如果新版仍在运行，先按 `Ctrl-C` 停止。进入**升级前能正常使用的旧版程序文件夹**（若已删除，请重新解压对应旧版本并运行 `just setup`）。
2. 在旧版程序目录中完成[通用恢复步骤](#通用恢复步骤以换新电脑或找回数据为例)的第 2–4 步，恢复时选择**升级前制作的备份**即可。


## 没有安装 just 时

若未安装 `just`，可在程序根目录用 `uv run --project backend --no-dev python -m app.config` 核对源库，再运行对应的备份或恢复命令。平时若用 `FOLIO_J_DATABASE_PATH` 临时指定学习库，核对和备份时同样要带上它。完整启动步骤见[快速开始](../README.md#快速开始)。

```sh
# 制作备份
uv run --project backend --no-dev python -m app.backup create "$HOME/folio-backup-01"

# 从已有备份恢复
uv run --project backend --no-dev python -m app.backup restore "$HOME/folio-backup-01" "$HOME/folio-restored-01"
```
