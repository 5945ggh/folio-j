# Folio-J 实验目录包

本包在本机运行服务，使用系统浏览器阅读。无需另外安装 Python、Node.js、uv 或 pnpm。请完整保留目录结构，不要只复制可执行文件。

在终端进入本目录，运行 `./Folio-J data-path` 核对数据位置（不会创建数据库），再运行 `./Folio-J start`。Windows PowerShell 使用 `.\Folio-J.exe data-path` 和 `.\Folio-J.exe start`。启动后会打开系统浏览器；使用 `start --no-browser` 可自行打开终端显示的地址。在终端按 `Ctrl-C` 停止服务。

新安装首次启动会打开数据位置页，可使用默认 `~/Folio-J-Data`、填写其他绝对目录创建新数据，或打开已有学习库。确认前不创建默认目录，之后自动记住位置；旧数据库和配置继续可用。数据不可访问或启动失败时保留恢复页，可重试原位置或重新选择，不会自动改用空库。当前路径可在“设置 → 数据位置”查看。拒绝访问也可能来自安全软件对进程的拦截，不表示必须以管理员身份使用。

如需重新打开选择页，先停止服务，再运行 `./Folio-J start --choose-data`（Windows 为 `.\Folio-J.exe start --choose-data`）。这只选择位置，不搬迁数据；备份恢复到新位置后，用“打开已有数据”选择恢复库。`FOLIO_J_DATABASE_PATH` 仍具有最高优先级，选择其他位置前须先修改或移除它。升级时解压到新程序目录即可继续使用已记住的库，启动沿用 Alembic 迁移，不会自动清空数据库。

位置记录与学习库分开：Windows 为当前用户注册表 `HKCU\Software\Folio-J`，macOS／Linux 为 `~/.config/folio-j/data-location.json`（设置 XDG_CONFIG_HOME 时使用该目录）。旧 `~/Folio-J-Data/app.toml` 继续配置端口等参数；数据库路径优先级为环境变量、已记住位置、程序配置、旧用户配置、旧程序库及默认位置。

冻结程序在交互控制台中失败退出时会等待回车，便于读取错误。正常停服与管道调用不等待；反馈前请去除日志中的私人路径和内容。

备份前先停止服务。运行 `./Folio-J backup /绝对路径/新备份目录`；恢复使用 `./Folio-J restore /绝对路径/备份目录 /绝对路径/新恢复目录`。目标目录必须尚不存在。备份可能包含模型凭据，请保存在私人目录。Windows 示例：`.\Folio-J.exe backup C:\私人备份\备份01`、`.\Folio-J.exe restore C:\私人备份\备份01 C:\私人数据\恢复01`；路径含空格时加双引号。恢复后重开选择页，用“打开已有数据”选择新恢复目录，再在设置中核对路径。

这是按构建机器的平台与架构生成的实验包；Windows 使用 ZIP，其他平台使用 tar.gz。解压到独立程序目录后再运行，不从压缩包内部直接启动。各系统与设备的验收范围以对应版本的发布说明为准；本包未做正式发行签名与公证。`RELEASE.json` 记录版本与代码基准，`BUILD.json` 记录工作区状态、运行时与词典版本；现有数据升级前请先备份。

## 许可证

Folio-J 采用 AGPL-3.0-or-later。完整条款见 [LICENSE](LICENSE)，授权范围与源代码获取说明见 [COPYING.md](COPYING.md)。随包依赖的声明见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。
