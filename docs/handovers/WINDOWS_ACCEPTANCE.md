# Windows 实验性支持验收

本清单供 Windows 11 x64、PowerShell、Chrome 与 Edge 实机验收使用。Windows CI 与实机验收目前均未运行；完成下表并记录版本后，再判断具体环境是否可用。测试按本机单用户使用，文件沿用所在目录的继承权限，不设置 Windows ACL，也不提供系统用户之间的隔离保证。

操作说明见[使用指南](../USAGE.md)，备份结构及升级步骤见[升级与备份](../UPGRADING.md)。本清单只使用独立测试资料和数据目录。核心项目无需模型、密钥或真实网络模型调用。

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

已添加 Windows CI，等待提交并在远端执行。`dev` 热重载、实体终端 Ctrl-C／关闭窗口、系统字体、选区、剪贴板与设备声音由下面的实机项目核验。Windows 文件内容保留刷盘，目录元数据未提供 POSIX 等价的断电耐久性保证。

## 2026-11-01 CR 修复复验

在上述工作区继续修复 P2、P3，尚未提交。Windows 开发模式改用共享停止事件，热重载与退出均等待旧 worker 完成清理；正常关闭后端时不再用固定五秒截断。旧单词典索引因占用而延迟删除后，进程重启也能在后续词典变更时重新发现并回收，仍保留有引用及未知损坏的旧文件。

[启动回归](../../backend/tests/test_windows_reload.py)通过真实 `run.main`、Uvicorn 与合成 ASGI lifespan 的关闭屏障，验证启动器等待、重复停止信号、热重载更换 PID，以及重载期间停止后不再启动后继。macOS 执行共享事件及生命周期路径；Windows 分支使用独立控制台、真实进程组停止，并将屏障保持超过五秒，须由 Windows CI 原生执行。[入口接线回归](../../backend/tests/test_run_script.py)同时检查平台入口选择及后端等待对象。

[词典回归](../../backend/tests/test_dictionary_library.py)覆盖旧单索引／目录索引、重启后选择／重导两类触发，并承接目录引用、损坏文件及并发重导保护。新增旧索引场景在修复前为 2 失败、2 通过；修复后词典定向测试 47 项通过。

| 检查 | 结果与范围 |
| --- | --- |
| `just lint` | 全部通过 |
| `just test` | 后端 1272 通过、2 跳过；前端 810 通过。跳过项仍为 Windows Job Object 测试；新增生命周期测试的 Windows 控制台分支在 macOS 上未执行 |
| Windows 目标静态检查 | 全项目 Pyright `--pythonplatform Windows` 通过 |
| 源码 ZIP 冒烟 | 发行清单已包含新重载入口；隔离工作区快照打包后，在临时中文与空格目录中，从离线缓存安装、构建、迁移、启动退出、备份恢复、拒覆盖及恢复库重启通过；执行环境仍为 macOS |
| 文档 | `just check-docs` 与 `git diff --check` 通过；私有证据未核验 |
| 独立复核 | P2 的进程控制与回归未发现新的阻断；Windows 原生控制台及 Job Object 仍待执行 |

P2、P3 的代码问题已修复，本机回归通过。合入 `main` 前仍应取得包含上述回归的 Windows CI 通过结果；Windows 实机清单继续保留待验状态。

## 核心必须

### 准备独立环境

准备 Python 3.11、Node.js 24、uv、pnpm 10；需要验证命令入口时另装 just。用普通用户打开一个专用 PowerShell，记录工具版本：

```powershell
uv --version
node --version
pnpm --version
just --version
$PSVersionTable.PSVersion
```

创建带中文和空格的验收目录，将待测源码或源码包的内容放进下面的 `$winProgram`。不要复制旧程序的 `.venv`、`node_modules`、真实配置和学习数据。

```powershell
$winRoot = Join-Path $env:TEMP ('Folio-J Windows 验收 ' + [guid]::NewGuid().ToString('N'))
$winProgram = Join-Path $winRoot '程序 中文 路径'
$winData = Join-Path $winRoot '学习 数据'
New-Item -ItemType Directory -Path $winProgram, $winData | Out-Null
$env:FOLIO_J_DATABASE_PATH = Join-Path $winData 'app.db'
$winRoot
# 将程序文件放好后继续；以下命令均在程序根目录执行。
Set-Location $winProgram
```

把测试配置写入这份独立程序的 `config/app.toml`；绝对路径用 TOML 单引号，保留 Windows 反斜杠。以下写法兼容 PowerShell 5.1，避免生成带 BOM 的 TOML。

```powershell
$winConfig = @"
[database]
path = '$env:FOLIO_J_DATABASE_PATH'
[server]
port = 8017
dev_port = 5188
"@
[IO.File]::WriteAllText((Join-Path $winProgram 'config\app.toml'), $winConfig, [Text.UTF8Encoding]::new($false))
```

端口若已占用，改成另一对空闲端口，并同步下面的启动、检查和浏览器地址。准备一本含日文、振假名和插图的可重排 EPUB，以及两份不同的 Yomitan format 3 测试词典 ZIP。完整仓库可直接使用 `backend/tests/fixtures/epub/synthetic-reading.epub`；源码包使用自备测试书。记录一个待保存的句子及所在章，后续检查复用它。

### 安装、配置与进程

有 just 时运行 `just setup`、`just data-path`，确认数据库在 `$winData` 下，再运行 `just start`。没有 just 时依次执行：

```powershell
uv sync --project backend --locked --no-dev
pnpm --dir frontend install --frozen-lockfile
uv run --project backend --no-dev python -m app.config
uv run --directory backend --no-dev alembic upgrade head
pnpm --dir frontend build
uv run --project backend --no-dev python scripts/run.py start
```

每步检查 `$LASTEXITCODE`；失败时先保留日志，处理后再继续。有 just 的环境也要停止服务后试一次直接启动命令，确认两种入口一致。

- [ ] Python 版本为 3.11，依赖安装与空库迁移完成；终端显示正确的中文空格数据路径，浏览器可打开 `http://127.0.0.1:8017`。
- [ ] 停止服务，临时移除环境覆盖：`Remove-Item Env:FOLIO_J_DATABASE_PATH`，运行 `just data-path` 或直接配置命令，仍指向测试配置指定的同一个库；之后重新设置 `$env:FOLIO_J_DATABASE_PATH = Join-Path $winData 'app.db'`。改用正斜杠写同一路径也能识别。真实用户配置无需修改。
- [ ] 再运行迁移并重启，已有记录不丢失。程序目录与数据目录分开；程序目录内没有意外生成另一份 `data/app.db`。
- [ ] 第一实例运行时，在另一 PowerShell 进入同一程序目录，设置同一个数据库环境变量，再用另一端口执行 `uv run --project backend --no-dev uvicorn app.main:app --host 127.0.0.1 --port 8018`。第二实例应因数据库已有执行进程而退出；第一实例继续可用。另一端口用于区分数据库锁与端口冲突。
- [ ] 在运行终端按一次及连续两次 Ctrl-C，服务均能退出；重复启动正常。`Get-NetTCPConnection -State Listen -LocalPort 8017,5188 -ErrorAction SilentlyContinue` 不再列出本次服务的监听项。
- [ ] 单独测试异常关闭：记录本次启动器 PID，用任务管理器结束该启动器进程，检查其 API／前端子进程及监听端口一并退出；随后重启，能取得同一库的锁。只操作本次临时实例。
- [ ] 完整仓库另运行 `just dev`，检查 5188 页面与 API 代理、后端修改后的热重载，以及 Ctrl-C 后两个端口释放。源码包没有开发脚本时记为“不适用”。

### 阅读、词典与人工资料

以下核心流程在 Chrome、Edge 各执行一次。首次启动应看到空素材库；第二个浏览器应能看到已保存的资料。不要把其他浏览器的本地偏好当作应自动迁移的数据。

- [ ] 新建来源并导入测试 EPUB，书名、封面、插图及日文正常；横排／竖排、分页／滚动、浅色／深色、宽窗口与窄窗口切换后无内容丢失和挡住操作的溢出。
- [ ] 从目录、书内搜索和书签分别跳转；在一段中间停留，刷新、离开再进入、关闭浏览器后重开，位置仍指向同一正文附近。重复文字不会跳到另一章。
- [ ] 鼠标划选含振假名和标点的原文，工具条定位可用；复制原文、带上下文复制和复制讲解提示词，粘贴到本地记事本，核对日文、换行、目标范围与上下文。无模型时仍能完成这些操作。
- [ ] 导入两份词典、重复导入同一份，核对安装项不重复；切换当前词典，正文与词卡内继续查词均显示当前词典的释义。
- [ ] 打开词卡后删除当前词典并明确选择替代词典，旧词卡关闭或更新；删除非当前词典，再删除最后一本，显示空状态。重启后不复活；同一 ZIP 可重新导入。若删除时旧查询仍在进行，完成后不得覆盖新词典结果；关闭页面或停止进程后检查文件占用已释放。
- [ ] 保存准备好的原句为学习片段，手写或粘贴一份含两节 Markdown 的讲解；编辑标题和正文后保存。从来源目录重新打开，核对内容。
- [ ] 将阅读位置移到另一章，停止并重启服务；从来源找到刚才的讲解，再点「在原文中定位」，应回到保存的章和原句。正文标记能打开同一份讲解。重复迁移后结果相同。

### 备份、恢复与版本替换

先停止应用，保留刚才的 EPUB、词典、片段与讲解。以下源路径仍为 `$env:FOLIO_J_DATABASE_PATH`。

```powershell
$winBackup = Join-Path $winRoot '备份 01'
$winRestore = Join-Path $winRoot '恢复 数据 01'
just data-path
just backup $winBackup
just restore $winBackup $winRestore
# 无 just 时用下面两条替代 backup/restore，不重复执行到相同目标。
# uv run --project backend --no-dev python -m app.backup create $winBackup
# uv run --project backend --no-dev python -m app.backup restore $winBackup $winRestore
$env:FOLIO_J_DATABASE_PATH = Join-Path $winRestore 'app.db'
just data-path
just start
```

没有 just 时，最后两步沿用前面直接查看配置与启动的命令。

- [ ] 应用运行时尝试备份，明确拒绝；停止后备份和恢复成功，恢复路径不同于源库。恢复后核对书籍、阅读位置、书签、词典安装／选择、片段和讲解；原库仍在原处。
- [ ] 停止服务后，重复向已有备份目录备份、向已有恢复目录恢复，均拒绝覆盖；对测试目录里预建的空目录也应拒绝。
- [ ] 复制备份为另一份测试副本，截断副本中的 `app.db` 或修改 `manifest.json` 中的摘要，再恢复到全新目录，应明确失败且不留下可误当成功的新库。原备份与原库仍可使用。
- [ ] 将同一版本或待升级版本放到第二个独立程序目录，重新安装依赖，使用原测试库的绝对环境路径及同样端口配置。核对路径后迁移、启动，资料仍在；旧程序目录不必搬动。升级失败的回退使用升级前备份恢复到新目录，避免让旧版直接读已升级库。
- [ ] 在另一套匹配版本的 macOS／Linux 环境恢复 Windows 创建的完整备份；反向也做一次，均恢复到新目录，按恢复输出的原生路径配置并核对同一组资料。配置文件和浏览器偏好单独记录；缺少第二台系统时明确记“未验证”。

## 设备体验

- [ ] Chrome、Edge 分别测试窗口缩放、Windows 显示缩放和触控板／鼠标翻页，记录缩放比例、窗口大小与异常截图；有触屏时再测选区手势。
- [ ] 打开设备朗读，检查可用的日语声音、开始、暂停、继续、停止、切句和离页。缺少声音时记录“设备未提供日语声音”，另测界面能否正确提示；不据静音判断朗读通过。
- [ ] 检查原书振假名与自动注音、竖排标点、长释义词卡、中文输入法和剪贴板授权提示；使用各浏览器的正常窗口实际操作，记录权限选择。

## 可选检查与结果记录

完整仓库可运行 `just lint`、`just test`、`just build`、`just check-docs`、`just test-browser`，源码包不含开发测试资产。无 just 的直接检查入口为 `uv run --project backend pytest backend/tests`、`pnpm --dir frontend test` 和 `pnpm --dir frontend test:browser`；这些自动测试禁止访问真实模型。浏览器自动检查可用 `$env:CHROME_BIN = '浏览器可执行文件的绝对路径'` 分别指定 Chrome 与 Edge；完成后用 `Remove-Item Env:CHROME_BIN` 清除覆盖。记录跳过原因，尤其是私有样书缺失或系统不允许创建符号链接。

真实模型测试由使用者自行选择：原文与所需上下文会发往配置的服务，可能产生服务商费用。可用少量自造日语测试翻译、讨论、保存 AI 讲解，以及重启后查回结果；记录模型／协议和现象，不提供或收集密钥。这部分不计入离线自动测试，也不是核心验收的前置条件。若配置过凭据，备份可能含未加密密钥，不要公开上传。

每项填写“通过／失败／未验证／不适用”，失败附最短复现、预期与实际行为。分享日志前去掉凭据、私人书文和个人路径。

| 记录项 | 填写内容 |
| --- | --- |
| 验收日期与代码 | 日期；Git 提交号或源码包 RELEASE.json；是否含未提交修改 |
| Windows 与终端 | Windows 11 构建号／x64；PowerShell、Python、Node、uv、pnpm、just 版本 |
| 浏览器与设备 | Chrome／Edge 版本、显示缩放、输入设备、日语声音 |
| 临时目录与端口 | 程序／源数据／恢复数据绝对路径；API／前端端口 |
| 本机自动验证 | 上述记录为开发机结果；填写 Windows 实际命令、环境、结果与跳过项，以及 Windows CI 链接 |
| 核心与设备结果 | 按上面各项记录结果；Windows 实机：尚未运行 |
| 跨系统与模型 | 对端系统／版本及恢复结果；可选模型测试是否执行与费用范围 |
| 问题与材料 | 复现步骤、退出码、脱敏日志和截图位置；后续复测结果 |

结束时停止测试服务，保留需要的验收记录、源码和临时数据；在专用终端退出前可用 `Remove-Item Env:FOLIO_J_DATABASE_PATH` 清除覆盖。需要长期保留的资料移到自行管理的位置，临时目录可能被系统清理。
