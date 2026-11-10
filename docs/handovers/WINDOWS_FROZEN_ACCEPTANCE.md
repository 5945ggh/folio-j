# Windows 冻结包修复与验收

2026-11-09，实施起点为本地 `main 81975d00`，修复位于 `codex/windows-frozen-fixes`。代码包含该提交之前的全局导航和片段即时查词。构建命令、镜像备用路径及 bundle 转移方式由[开发指南](../DEVELOPMENT.md#实验目录包)维护；Windows 人工验证使用[实机清单](WINDOWS_ACCEPTANCE.md)。

## 起因与范围

用户转述的 Windows AMD64 首轮构建基于 `e9b8eb16`，Python 3.11.14、PyInstaller 6.22.3。原始目录及中文空格路径 ZIP 在临时绕过后完成 HTTP 冒烟；该报告没有附上绕过补丁与完整日志，不能作为本批未修改冒烟或生产修复的通过证据。浏览器走查、真实控制台 Ctrl-C 和下载拦截仍未验证。

本批将 CLI 的 Windows 管道输出固定为 UTF-8，避免默认代码页无法编码 emoji 和罕用汉字。`SIGBREAK` 处理器仅在服务器运行期间调整并恢复；保留清理、正常退出与启动失败的区别。冻结包冒烟继续要求退出码 `0`，严格解码 UTF-8，并以含 `🗂`、`𠮷` 的数据及备份路径覆盖输出。

Windows 构建器直接输出 ZIP，POSIX 平台继续输出保留权限与符号链接的 tar.gz。新增独立 Windows 冻结包 CI 任务，对原始目录和 ZIP 解压目录各执行完整冒烟，通过后收集对应提交的源码、构建信息和 SHA-256 校验文件。不修改数据库／API schema、prompt 或 TBD，不新增依赖。

## 源码与冻结入口的区别

源码 ZIP 冒烟启动 `scripts/run.py start`。父进程收到停止请求后返回 `0`，等待后端清理但不传播停止时的子进程退出码；冻结包直接运行 `app.launcher` 并检查该进程退出码。直接运行 `python -m app.launcher` 的 SIGBREAK 失败不能推断源码 ZIP CI 同样失败。

核对时远端最新 [Windows CI](https://github.com/5945ggh/folio-j/actions/runs/42487542072) 对应 `fa284419`，源码 ZIP 步骤通过；它未覆盖本批冻结产物或尚未推送的本地提交。

## 本地验证

本批本机为 macOS ARM64，代码交付检查通过：

- `just lint`：Ruff、pyright strict、Biome、TypeScript 和既有原型语法检查通过。
- `just test`：后端 1414 passed、3 skipped；前端 826 passed。新增 Windows 原生控制台回归按平台跳过；跨平台单元回归覆盖真实 cp936 标准流、缺失／替代流、SIGBREAK 注册恢复与启动失败。
- `just build`：最新前端生产构建通过，包含 `81975d00` 的查词修改。
- `just check-docs` 与 `git diff --check` 通过；私有历史证据未核验。
- `0.1.0-frozen-trial.4-local` 真实 macOS 目录包构建通过，原目录及 tar.gz 解压到中文空格路径后的两次完整冻结包冒烟通过，均使用独立临时数据与合成 loopback Provider。包的 `dirty=true` 如实记录当前工作区；该本地产物只用于验证。
- Windows ZIP 的本地归档回归检查完整目录、Unicode 文件名和内容；POSIX 回归检查执行权限与符号链接。workflow 经本地 YAML 解析检查。

本批未修改 UI，无新增浏览器回归。Windows 原生信号回归、新增冻结包 CI、PowerShell 命令实跑、镜像实际下载安装和浏览器人工验收尚未执行；本机无 PowerShell／actionlint。镜像依赖清单的锁定导出已在本机离线验证。

## Windows 接力

修复提交后，从包含最新提交的 `main` 导出 Git bundle，在 Windows 更新干净检出，再构建新的试用版本。不得沿用首轮 ZIP 的版本、摘要或通过结论。核对 `BUILD.json` 的提交与 `dirty` 状态，原目录和最终 ZIP 解压后各运行未修改的 `smoke_frozen.py`。

通过自动验证后，在 Chrome／Edge 人工核对阅读、即时查词、片段完整资料浮层、保存与重启，以及换程序目录后使用同一数据、备份恢复和真实 Ctrl-C 停服。真实模型、朗读声音、Defender／SmartScreen 和正式签名分别记录结果；HTTP 冒烟不替代浏览器和设备体验。

## Windows 控制台日志修复

2026-11-09，用户转述 Windows 实机日志原样显示 `ESC[32m`、`ESC[1m` 等 ANSI 颜色控制码。另有普通权限访问 `C:\Users\nxx\Folio-J-Data\app.db` 返回 WinError 5 的报告；本轮按用户要求只处理日志，数据目录权限与闪退继续由 Windows 端复测。

从 `main b64314f5` 开始，将 Windows `app.launcher` 的 Uvicorn 配置设为 `use_colors=False`，启动日志及 HTTP 访问日志均为纯文本，其他平台保留自动颜色判断。不引入 Win32 终端模式操作，不新增启动脚本、退出等待或 ACL 修改，无新增依赖或 TBD。

回归通过实际启动配置创建 Uvicorn formatter，模拟 stdout／stderr 均为 TTY，核对 Windows 的 INFO、请求行与 `200 OK` 无 ANSI 序列，其他平台仍可自动着色。启动入口定向测试 25 passed；`just lint`、`just test`、`just check-docs` 和 `git diff --check` 通过，全量后端 1416 passed、3 skipped，前端 826 passed。未修改前端，未重跑生产构建或浏览器回归；Windows 默认控制台与 Windows Terminal 的实际显示尚未复验。

## 工作流表达式作用域修复

2026-11-10，推送 `0c1e0744` 后，[Windows workflow](https://github.com/5945ggh/folio-j/actions/runs/42732287086) 在调度前失败：冻结任务的 job 级 `env` 使用了两处 `runner.temp`，GitHub 在该层级不提供 `runner` context。[官方 context 表](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability)明确区分 job 与 step 的可用范围；此前本地 YAML 解析未覆盖表达式作用域。

从 `main 0c1e0744` 开始，将冻结构建环境和产物路径移到现有初始化 step，用 `Join-Path $env:RUNNER_TEMP` 构造路径并通过 UTF-8 写入 `GITHUB_ENV`。安装依赖、构建、冒烟和上传均在后续步骤读取，保留 runner 临时目录及独立虚拟环境。没有新增项目依赖、应用行为、schema 或 TBD。

临时安装的 actionlint 1.7.12 在修复前准确检出两处非法 context，修复后的完整 workflow 通过专用语法与表达式检查。`just lint`、`just test`、`just check-docs` 和 `git diff --check` 通过；后端 1507 passed、4 skipped，前端 826 passed。独立工作区复用既有依赖，显式指定本工作区 `PYTHONPATH` 并使用 `UV_NO_SYNC=1 UV_OFFLINE=1`；测试真实网络保持禁用，允许本机 socketpair。实际 Windows CI 结果仍以修复推送后的远端运行为准。
