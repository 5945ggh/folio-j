# Windows 源码包与自动验证记录

以下保留 2026-11-01 的本机验证及七轮 Windows CI 结果。当前支持范围与实机待测项目见[Windows 验收清单](../WINDOWS_ACCEPTANCE.md)。

## 2026-11-01 本机自动验证

代码基准为 `74fc84e` 上的 `codex/windows-experimental-support` 工作区，尚未提交。执行环境为 macOS、Python 3.11.14、Node.js 24.22.1；下列结果不能替代 Windows 原生执行。

| 检查 | 结果与范围 |
| --- | --- |
| `just lint` | Ruff、Pyright、Biome、TypeScript 和原型语法检查通过 |
| `just test` | 后端 1263 通过、2 跳过；跳过项为仅 Windows 可执行的 Job Object 进程生命周期测试。前端 810 通过 |
| Windows 目标静态检查 | `uv run --project backend pyright --project backend --pythonplatform Windows` 通过；只验证类型与平台分支，不执行 Windows 系统调用 |
| 浏览器工具 | 本机 Chrome 的 `app-theme` 4 个场景通过；Windows Chrome／Edge 尚未运行 |
| 源码 ZIP 冒烟 | 当前发行清单的工作区文件复制到临时 Git 仓库后打包，独立解压、从缓存安装、生产构建、空库迁移、`start` 启停、中文日文资料备份恢复、拒覆盖和恢复库重启通过。路径包含中文、空格、`&`、`$`，没有使用日常库或模型 |
| 文档 | `just check-docs` 与 `git diff --check` 通过；私有验收证据未核验 |

已添加 Windows CI，等待提交并在远端执行。`dev` 热重载、实体终端 Ctrl-C／关闭窗口、系统字体、选区、剪贴板与设备声音由[实机清单](../WINDOWS_ACCEPTANCE.md)核验。Windows 文件内容保留刷盘，目录元数据未提供 POSIX 等价的断电耐久性保证。

## 2026-11-01 CR 修复复验

在上述工作区继续修复 P2、P3，尚未提交。Windows 开发模式改用共享停止事件，热重载与退出均等待旧 worker 完成清理；正常关闭后端时不再用固定五秒截断。旧单词典索引因占用而延迟删除后，进程重启也能在后续词典变更时重新发现并回收，仍保留有引用及未知损坏的旧文件。

[启动回归](../../../backend/tests/test_windows_reload.py)通过真实 `run.main`、Uvicorn 与合成 ASGI lifespan 的关闭屏障，验证启动器等待、重复停止信号、热重载更换 PID，以及重载期间停止后不再启动后继。macOS 执行共享事件及生命周期路径；Windows 分支使用独立控制台、真实进程组停止，并将屏障保持超过五秒，须由 Windows CI 原生执行。[入口接线回归](../../../backend/tests/test_run_script.py)同时检查平台入口选择及后端等待对象。

[词典回归](../../../backend/tests/test_dictionary_library.py)覆盖旧单索引／目录索引、重启后选择／重导两类触发，并承接目录引用、损坏文件及并发重导保护。新增旧索引场景在修复前为 2 失败、2 通过；修复后词典定向测试 47 项通过。

| 检查 | 结果与范围 |
| --- | --- |
| `just lint` | 全部通过 |
| `just test` | 后端 1272 通过、2 跳过；前端 810 通过。跳过项仍为 Windows Job Object 测试；新增生命周期测试的 Windows 控制台分支在 macOS 上未执行 |
| Windows 目标静态检查 | 全项目 Pyright `--pythonplatform Windows` 通过 |
| 源码 ZIP 冒烟 | 发行清单已包含新重载入口；隔离工作区快照打包后，在临时中文与空格目录中，从离线缓存安装、构建、迁移、启动退出、备份恢复、拒覆盖及恢复库重启通过；执行环境仍为 macOS |
| 文档 | `just check-docs` 与 `git diff --check` 通过；私有证据未核验 |
| 独立复核 | P2 的进程控制与回归未发现新的阻断；Windows 原生控制台及 Job Object 仍待执行 |

P2、P3 的代码问题已修复，本机回归通过。合入 `main` 前仍应取得包含上述回归的 Windows CI 通过结果；Windows 实机清单继续保留待验状态。

## 2026-11-01 Windows CI

已提交的适配与 CR 修复从 `61b22af` 开始在 `windows-2025` runner 上执行；修复过程如下。该 runner 的结果用于验证 Windows 原生路径，Windows 11 实机操作与设备体验仍按下方清单验收。

| 执行与代码 | 结果、原因与后续修复 |
| --- | --- |
| [第一轮](https://github.com/5945ggh/folio-j/actions/runs/41286905744)，`61b22af` | Git `autocrlf` 将源码转为 CRLF，Biome 报告 418 个格式错误。`127a5e1` 添加 `.gitattributes` 固定 LF；隔离检出核对 529 个源码文件保持 LF，EPUB 字节不变 |
| [第二轮](https://github.com/5945ggh/folio-j/actions/runs/41287135499)，`127a5e1` | 静态检查通过；测试网络保护误挡 CPython 3.11 的 Windows `socketpair` 内部握手，出现 758 个 setup error 和 12 个迁移测试失败，另发现 CLI 父进程按 cp1252 解码及日文 fixture 读取编码问题。`3e8180e` 按调用方、socket 与端点精确允许内部握手，继续拒绝其他线程及直接连接；`aadb226` 统一 UTF-8 并补充回归 |
| [第三轮](https://github.com/5945ggh/folio-j/actions/runs/41288043014)，`aadb226` | 后端 1279 通过、2 失败、2 error、2 跳过，耗时 646.16 秒。失败来自 Windows 非法 `?` 文件名及损坏词典测试未关闭连接；error 来自长文本参数 ID 使 `PYTEST_CURRENT_TEST` 超过 32767 字符。`9272c92` 关闭夹具连接，`5963a91` 按平台使用合法特殊文件名，`ef06077` 缩短参数 ID，保留实际 60000 字输入，并添加 CI 跳过原因与慢测试输出 |
| [第四轮](https://github.com/5945ggh/folio-j/actions/runs/41289269118)，`ef060771bdb6c6117c597bd248a1f425ba964d3c` | 后端 1281 通过、1 失败、2 跳过，耗时 758.54 秒。唯一失败为热重载清理期间立即重复发送 SIGINT／SIGBREAK 的场景，reloader 提前退出；夹具文件名、连接关闭、长参数 ID、编码、禁网与迁移回归均通过。跳过项为未分发的私有只读样书及 POSIX 进程组测试；前端、生产构建、浏览器及源码 ZIP 步骤未继续执行 |
| [第五轮](https://github.com/5945ggh/folio-j/actions/runs/41290912177)，`8c3c4d221f8504ed23e0fa2836e62303c75bab6e` | 静态检查通过；生命周期前置回归 20 通过、1 项 POSIX 测试跳过。完整后端 1291 通过、1 失败、2 跳过，耗时 685.95 秒；唯一失败为 `test_opening_snapshot_and_delete_are_coordinated_without_holding_reader_lock`，测试等待删除超过一秒，清理时再次等待已取消的任务，最终抛出 `asyncio.exceptions.CancelledError`。跳过项仍为私有只读样书与 POSIX 进程组。前端、构建、浏览器及源码 ZIP 步骤未执行。后续改用独立连接探测目录锁，并在删除后验证旧快照可读 |
| [第六轮](https://github.com/5945ggh/folio-j/actions/runs/41292931378)，`7b1a532` | 词典并发回归、完整测试、生产构建及 Chrome／Edge 冒烟通过。源码 ZIP 在中文路径执行 `just setup` 时，Python 3.11 按 cp1252 读取含 UTF-8 源码路径的可编辑安装 `.pth`，启动失败 |
| [第七轮](https://github.com/5945ggh/folio-j/actions/runs/41295576476)，`386a683` | 全流程通过。后端 1292 通过、2 跳过，前端 810 通过。中文路径解压后安装、迁移、启停、备份恢复、拒绝覆盖及恢复后重启通过。后端另记录一项线程警告：aiosqlite 工作线程向已关闭的事件循环回传结果，来源待定位 |

第三轮的原生平台锁 6 项、Job Object 2 项及新增生命周期 4 项均已通过。第四轮前的本机 `just lint`、`just test` 通过，后端 1282 通过、2 跳过，前端 810 通过；Windows 目标 Pyright 通过，之后仅修改夹具连接、名称及参数 ID。

第四轮失败后的修复让 `run.main` 每次调用各自保存停止标记，SIGINT／SIGTERM／SIGBREAK handler 只记录停止请求，并在整个清理过程中保持同一 handler。独立复现表明，旧实现安装忽略 handler 前仍可能由 Python 待处理信号再次抛出异常；第四轮日志未捕获异常栈，因此该原因是复现支持的判断。旧实现的 5 组确定性回归失败，新增回归共 10 组，覆盖混合信号、清理重入、自然退出后的信号及多次调用状态重置；原生立即重复信号的清理屏障检查继续保留，并增强子进程日志。定向验证 19 通过、2 跳过。修复已随 `8c3c4d2` 提交，本机最终 `just lint`、`just test` 通过，后端 1292 通过、2 跳过，前端 810 通过；Windows 目标全项目 Pyright 与文档检查通过。该确切提交的源码包在 macOS 上完成独立解压、构建、迁移、启动退出、备份恢复、拒覆盖及恢复库重启，结果通过。CI 已增加生命周期前置检查，以便在完整测试前暴露同类问题。上述修复未改变生产 schema、依赖或 TBD。
