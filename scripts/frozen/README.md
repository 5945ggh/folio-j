# Folio-J 实验目录包

本包在本机运行服务，使用系统浏览器阅读。无需另外安装 Python、Node.js、uv 或 pnpm。请完整保留目录结构，不要只复制可执行文件。

在终端进入本目录，运行 `./Folio-J data-path` 核对数据位置，再运行 `./Folio-J start`。Windows 将 `./Folio-J` 换成 `./Folio-J.exe`。启动后会打开系统浏览器；使用 `start --no-browser` 可自行打开终端显示的地址。在终端按 `Ctrl-C` 停止服务。

新安装默认将书籍与学习记录放在 `~/Folio-J-Data/app.db`。可在 `~/Folio-J-Data/app.toml` 设置数据库绝对路径及端口，也可通过 `FOLIO_J_DATABASE_PATH` 指定数据库。不要将日常数据放在本程序目录内；升级时解压到新目录，核对数据路径后启动。启动会执行现有 Alembic 迁移，不会自动清空数据库。

备份前先停止服务。运行 `./Folio-J backup /绝对路径/新备份目录`；恢复使用 `./Folio-J restore /绝对路径/备份目录 /绝对路径/新恢复目录`。目标目录必须尚不存在。备份可能包含模型凭据，请保存在私人目录。恢复后将数据配置指向新目录中的 `app.db`，再用 `data-path` 核对。

这是按本机平台与架构构建的实验包，尚未完成其他机器和系统的验证，也未做正式发行签名与公证。`RELEASE.json` 记录版本与代码基准，`BUILD.json` 记录工作区状态、运行时与词典版本；现有数据升级前请先备份。

## 许可证

Folio-J 采用 AGPL-3.0-or-later。完整条款见 [LICENSE](LICENSE)，授权范围与源代码获取说明见 [COPYING.md](COPYING.md)。随包依赖的声明见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。
