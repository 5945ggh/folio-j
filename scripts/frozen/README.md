# Folio-J 免安装目录包（实验性）

本发行包已内置运行环境与前端页面，无需另外安装 Python、Node.js、`uv` 或 `pnpm`，直接启动即可在系统浏览器中使用。

> **注意**：请先将压缩包完整解压到独立目录再运行，不要在压缩包内直接启动，也不要单独移动可执行文件（须完整保留同级目录结构）。本包为实验性构建，尚未做正式发行签名与公证。

## 快速开始

在终端进入解压后的 `Folio-J` 目录，运行启动命令：

```sh
# macOS / Linux
./Folio-J start
```

```powershell
# Windows PowerShell
.\Folio-J.exe start
```

启动后会自动打开系统浏览器（默认地址为 `http://127.0.0.1:8010`）。首次启动时，按页面提示选择数据存放位置（Windows 默认为 `%LOCALAPPDATA%\Folio-J\Data`，macOS 和 Linux 默认为 `~/Folio-J-Data`），或选择打开已有学习库即可进入应用。可直接粘贴 Windows 资源管理器复制的带双引号路径。等待时页面显示当前阶段；首次建库迁移失败后可重试当前选择，重启后也可在同一目录再次创建。在终端按 `Ctrl-C` 可停止服务。

- 从 [GitHub 发行页](https://github.com/5945ggh/folio-j/releases)下载 EPUB 样书，或导入自己的书籍。
- 阅读、查词和配置模型见[使用指南](docs/USAGE.md)。
- 更新版本、备份和迁移数据见[升级与备份](docs/UPGRADING.md)。

**常用命令与参数**：

- **查看当前生效的数据路径**（不会创建数据库）：`./Folio-J data-path`（Windows 为 `.\Folio-J.exe data-path`）
- **仅启动服务、不自动打开浏览器**：`./Folio-J start --no-browser`
- **重新选择数据位置**：先停止服务，再运行 `./Folio-J start --choose-data`（只切换读取位置，不会搬迁已有数据文件）

## 数据位置与版本升级

- **数据与程序分离**：学习数据保存在你选定的数据目录中，Windows 把位置记录写入 `%LOCALAPPDATA%\Folio-J\data-location.json`，macOS 和 Linux 写入 `~/.config/folio-j/data-location.json`。显式设置绝对路径 `XDG_CONFIG_HOME` 时，使用其下的 `folio-j/data-location.json`。
- **升级方式**：更新前请先备份数据。将新版解压到新文件夹后直接启动，程序会自动沿用已记住的数据位置并完成数据库升级，不会清空已有内容（旧版 Windows 若曾通过注册表记住自定义路径，首次启动新版时在页面重新选择原库即可）。
- **故障保护**：当原数据目录暂时无法访问（如外接硬盘未连接或被安全软件拦截）时，启动后会停留在恢复页面供你检查并重试，不会悄悄新建空库。
- **高级配置**：如需修改端口或通过环境变量 `FOLIO_J_DATABASE_PATH` 临时指定数据库，可参考包内的 `config/app.example.toml` 或在 `~/Folio-J-Data/app.toml` 中配置（环境变量优先级最高，设置后需先移除才能在页面切换其他位置）。

## 备份与恢复

操作前请先按 `Ctrl-C` 停止正在运行的 Folio-J。备份与恢复的目标文件夹均须尚不存在：

```sh
# macOS / Linux
./Folio-J backup "$HOME/folio-backup-01"
./Folio-J restore "$HOME/folio-backup-01" "$HOME/folio-restored-01"
```

```powershell
# Windows PowerShell（路径含空格时请加双引号）
.\Folio-J.exe backup "$HOME/folio-backup-01"
.\Folio-J.exe restore "$HOME/folio-backup-01" "$HOME/folio-restored-01"
```

- **凭据安全**：如果配置过模型服务，备份中可能包含未加密的 API 密钥，请妥善保存在个人私有目录。
- **启用恢复库**：执行 `restore` 后，运行 `./Folio-J start --choose-data`（Windows 为 `.\Folio-J.exe start --choose-data`），在页面选择「打开已有数据」并填入新恢复的目录，进入「设置 → 数据位置」确认即可。

## 排障与版本信息

- 程序在交互终端中异常退出时会等待按回车键，方便查看报错信息；提交反馈前请留意隐去日志中的私人路径与内容。
- 包内 `RELEASE.json` 记录版本号与代码提交号，`BUILD.json` 记录构建环境与内置分词词典版本。

## 许可证

Folio-J 采用 AGPL-3.0-or-later。完整条款见 [LICENSE](LICENSE)，授权范围与源代码获取说明见 [COPYING.md](COPYING.md)，随包依赖声明见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。
