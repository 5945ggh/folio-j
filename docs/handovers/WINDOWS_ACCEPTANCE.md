# Windows 实验性支持验收

本清单供 Windows 11 x64、PowerShell、Chrome 与 Edge 实机验收使用。当前交付与验证范围见[实施基线](MVP_IMPLEMENTATION_BASELINE.md)，既有结果见[源码 CI](archived/WINDOWS_CI_ACCEPTANCE.md)、[冻结包验收](archived/WINDOWS_FROZEN_ACCEPTANCE.md)和[数据位置验收](archived/DATA_LOCATION_ACCEPTANCE.md)。测试按本机单用户使用，文件沿用所在目录的继承权限，不设置 Windows ACL，也不提供系统用户之间的隔离保证。

操作说明见[使用指南](../USAGE.md)，备份结构及升级步骤见[升级与备份](../UPGRADING.md)。本清单只使用独立测试资料和数据目录。核心项目无需模型、密钥或真实网络模型调用。

## 2026-11-27 本机预验范围

基于 `1b3c7dc1` 的启动可靠性分支已在 macOS 源码入口和隔离程序副本验证。Chrome 实际走通带引号的自定义目录、创建学习库、重启后原库失联、放回并重试进入同一库。桌面及窄屏浏览器回归使用受控延迟验证阶段显示、提交超时后查询状态和禁止重复提交。真实 Alembic 迁移注入失败后，同会话与重启重选均可建库。`just lint`、Windows 目标 Pyright、`just gen-api` 和 `just check-docs` 通过。完整 `just test` 后端 1713 项通过、3 项跳过，前端 870 项通过。下列 Windows 11 解压包项目仍待实机填写。

## 核心必须

### 准备独立环境

从源码运行或构建时准备 Python 3.11、Node.js 24、uv、pnpm 10.34.5；需要验证命令入口时另装 just。用普通用户打开一个专用 PowerShell，记录工具版本：

```powershell
uv --version
node --version
pnpm --version
just --version # 仅已安装时记录
$PSVersionTable.PSVersion
```

创建带中文和空格的验收目录，将待测源码、源码包或完整冻结包的内容放进下面的 `$winProgram`。不要复制旧程序的 `.venv`、`node_modules`、真实配置和学习数据。

```powershell
$winUnicode = [char]::ConvertFromUtf32(0x1F4D6) + [char]::ConvertFromUtf32(0x20BB7)
$winRoot = Join-Path $env:TEMP ('Folio-J Windows 验收 ' + $winUnicode + ' ' + [guid]::NewGuid().ToString('N'))
$winProgram = Join-Path $winRoot '程序 中文 路径'
$winData = Join-Path $winRoot '学习 数据'
New-Item -ItemType Directory -Path $winProgram, $winData | Out-Null
$env:FOLIO_J_DATABASE_PATH = Join-Path $winData 'app.db'
$env:XDG_CONFIG_HOME = Join-Path $winRoot '位置 记录'
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

### 冻结包重建与检查

按[开发指南的 PowerShell 步骤](../DEVELOPMENT.md#windows-原生构建)从包含待验改动的已提交 `main` 建立干净检出。使用新试用版本和输出目录，核对 `BUILD.json` 的提交号与 `dirty` 状态，并按[最终 ZIP 解压验证](../DEVELOPMENT.md#最终-zip-解压验证)记录新 ZIP 的 SHA-256。以下检查无需 just。

#### 首次选择、记住位置与恢复

用普通用户另开 PowerShell，将最终 ZIP 解压到新目录。把下方 `Set-Location` 的路径替换为解压后的 `Folio-J` 目录。下面的临时用户目录和本地应用目录仅在该窗口生效，用于隔离日常库。

```powershell
$firstRun = Join-Path $env:TEMP ('Folio-J 首次启动 ' + [guid]::NewGuid().ToString('N'))
$env:USERPROFILE = Join-Path $firstRun '用户'
$env:LOCALAPPDATA = Join-Path $firstRun '本地应用数据'
New-Item -ItemType Directory -Path $env:USERPROFILE, $env:LOCALAPPDATA | Out-Null
Remove-Item Env:FOLIO_J_DATABASE_PATH, Env:XDG_CONFIG_HOME -ErrorAction SilentlyContinue
Set-Location -LiteralPath 'C:\解压目录\Folio-J' -ErrorAction Stop
.\Folio-J.exe start
```

- [ ] 首次打开浏览器时，默认路径为 `%LOCALAPPDATA%\Folio-J\Data`，点击确认前目录尚未创建。确认后进入素材库，在「设置 → 数据目录」核对路径。停止后核对 `%LOCALAPPDATA%\Folio-J\data-location.json`，重启打开原库。
- [ ] 使用 `start --choose-data`，粘贴资源管理器复制的含空格和外层双引号的其他目录，创建成功。再次重选时直接粘贴已有库文件路径，资料仍在。
- [ ] 用另一份临时用户环境分别验证旧 JSON 指向的自定义库、程序目录旧库和 `~/Folio-J-Data/app.db`，并核对旧 `app.toml` 生效。显式指定绝对 `XDG_CONFIG_HOME` 后，只读写该目录下的记录。优先级见[使用指南](../USAGE.md#配置优先级与高级选项)。
- [ ] 在独立测试卷使首次迁移中途失败（例如临时容量受限的卷）。记录失败阶段、耗时、底层异常和可用的 WinError；恢复空间后点击「重试当前选择」。另做一轮同样故障，先停服重启，再在原目录创建。核对其他已有库和无关 SQLite 文件仍保留。
- [ ] 在会长时间等待的测试运行中观察浏览器阶段提示，刷新或超时后回查仍在执行的操作；终端阶段和目标路径应一致，完成后只激活一个学习库。
- [ ] 在本地 NTFS 对照检查新数据、凭据、备份与恢复目录的继承权限。有 OneDrive／压缩文件或 exFAT 测试卷时，分别验证可用文件的启动、词典导入与停服备份；对备份树中的测试目录联接点仍应拒绝。记录文件系统与实际错误码。
- [ ] 在独立配置目录模拟记录写入受阻，选择测试库并启动：页面显示“应用已启动”、本次路径、下次可能需要重选的警告与“进入学习界面”按钮，隐藏选库控件；可进入素材库并使用本次库，终端保留 warning。停止后核对未声称已记住，恢复记录目录写入条件后再选库可正常保存。
- [ ] 在独立配置目录分别模拟损坏或不可读的 JSON 记录，启动保持恢复页，不静默切换默认库；原位恢复记录后可重试。仅操作测试记录，不改日常文件权限。
- [ ] 停止后更换完整程序目录，正常启动仍沿用已记住的测试库；旧 `app.toml`、环境变量和旧程序库兼容分别记录，不把临时环境覆盖当成已记住位置。
- [ ] 停服后仅暂时移开本次测试目录，重启显示恢复页、原路径和具体错误，不另建默认空库。放回目录后重试原位置，资料仍在。
- [ ] 若被安全软件阻止访问，保留实际路径与提示；根据本机策略处理可信程序的访问后，回到页面重试本次已确认位置。不能要求应用提权、删除学习库或关闭安全保护。安全软件实际授权效果仍须实机核对。
- [ ] `start --choose-data` 明确区分创建新数据与打开已有数据；新建不能覆盖已有库，已有模式不能在缺库处创建。普通 SQLite 或备份配套文件残留不能被当成可直接使用的学习库。
- [ ] 非零退出且 stdin、stdout 均为交互控制台时保留错误并等待回车，参数错误也可读；管道输入／输出的同类失败不等待，退出码保持非零。正常 Ctrl-C 停服不等待回车。

完成以上选择测试后，回到准备独立环境时打开的 PowerShell，使用已设置的测试库运行以下核心验收。浏览器的「设置 → 数据目录」支持复制、读取失败重试与长路径断行。

- [ ] Windows 本机完成构建，产物包含完整 `Folio-J/`、Windows ZIP、`BUILD.json` 与 `SIZE.json`；下载处同时有对应源码与构建脚本。
- [ ] 用构建环境的 Python 对原始 `Folio-J/` 运行 `scripts/smoke_frozen.py`；另将 ZIP 解压到新目录，再对解压出的 `Folio-J/` 运行同一脚本，两次分别记录结果。该脚本使用独立测试库，验证中文空格程序目录、含 emoji／罕字的数据／备份／恢复路径、UTF-8 管道输出、CTRL_BREAK 退出、服务、学习资料和备份恢复；自动结果不代替下面的实际浏览器操作。
- [ ] 从 ZIP 解压出的完整 `Folio-J/` 复制到 `$winProgram`，使用上面的独立数据环境变量。运行 `.\Folio-J.exe data-path`，输出为测试库绝对路径，`Test-Path $env:FOLIO_J_DATABASE_PATH` 仍为 `False`。
- [ ] 在 PowerShell 设置 `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)`，执行 `$winPathOutput = .\Folio-J.exe data-path | Out-String`，核对 `$winPathOutput` 中的中文、空格、emoji 和罕字未丢失或替换；测试结束恢复终端原编码或关闭专用终端。
- [ ] 运行 `.\Folio-J.exe start`，在 Chrome／Edge 完成下面“阅读、词典与人工资料”检查。停止并重启后保留内容；按一次及连续两次 Ctrl-C 均能退出并释放端口。`start --no-browser` 不自动打开浏览器。
- [ ] 分别从默认控制台和 Windows Terminal 启动，访问页面后日志显示可读的 `INFO`、请求路径及 `200 OK`，不出现 `ESC[32m`、`ESC[1m` 等控制码；Windows 冻结入口使用纯文本日志。
- [ ] 完成后面的“阅读、词典与人工资料”后，再按[备份、恢复与版本替换](#备份恢复与版本替换)验证已有资料。
- [ ] 将完整程序目录换到另一位置，保留独立数据路径；先 `data-path` 再 `start`，书籍、词典、片段与讲解仍可用。只搬可执行文件、遗漏 `_internal` 不属于有效升级方式。

冻结包完成后可跳过下面源码安装与源码开发模式项目，继续共用浏览器和备份清单。仅运行已构建的冻结包无需 Python、Node.js、uv 或 pnpm。

### 源码安装、配置与进程

有 just 时运行 `just setup`、`just data-path`，确认数据库在 `$winData` 下，再运行 `just start`。没有 just 时依次执行：

```powershell
uv sync --project backend --locked --no-dev
pnpm --dir frontend install --frozen-lockfile
uv run --project backend --no-dev python -m app.config
uv run --project backend --no-dev python -m app.launcher migrate
pnpm --dir frontend build
uv run --project backend --no-dev python scripts/run.py start
```

每步检查 `$LASTEXITCODE`；失败时先保留日志，处理后再继续。有 just 的环境也要停止服务后试一次直接启动命令，确认两种入口一致。

- [ ] Python 版本为 3.11，依赖安装与空库迁移完成；终端显示正确的中文空格数据路径，浏览器可打开 `http://127.0.0.1:8017`。
- [ ] 停止服务，临时移除环境覆盖：`Remove-Item Env:FOLIO_J_DATABASE_PATH`，运行 `just data-path` 或直接配置命令，仍指向测试配置指定的同一个库；之后重新设置 `$env:FOLIO_J_DATABASE_PATH = Join-Path $winData 'app.db'`。改用正斜杠写同一路径也能识别。真实用户配置无需修改。
- [ ] 再运行迁移并重启，已有记录不丢失。程序目录与数据目录分开；程序目录内没有意外生成另一份 `data/app.db`。
- [ ] 第一实例运行时，在另一 PowerShell 进入同一程序目录，设置同一个数据库环境变量，再用另一端口执行 `uv run --project backend --no-dev uvicorn app.main:app --host 127.0.0.1 --port 8018`。第二实例应因数据库已有执行进程而退出；第一实例继续可用。另一端口用于区分数据库锁与端口冲突。
- [ ] 第一实例运行时执行 `just migrate` 或上面的直接迁移命令，应提示数据库正在使用并退出，库版本与数据不变；停止实例后再次迁移成功。
- [ ] 在运行终端按一次及连续两次 Ctrl-C，服务均能退出；重复启动正常。`Get-NetTCPConnection -State Listen -LocalPort 8017,5188 -ErrorAction SilentlyContinue` 不再列出本次服务的监听项。
- [ ] 单独测试异常关闭：记录本次启动器 PID，用任务管理器结束该启动器进程，检查其 API／前端子进程及监听端口一并退出；随后重启，能取得同一库的锁。只操作本次临时实例。
- [ ] 完整仓库另运行 `just dev`，检查 5188 页面与 API 代理、后端修改后的热重载，以及 Ctrl-C 后两个端口释放。源码包没有开发脚本时记为“不适用”。

### 阅读、词典与人工资料

以下核心流程在 Chrome、Edge 各执行一次。首次启动应看到空素材库；第二个浏览器应能看到已保存的资料。不要把其他浏览器的本地偏好当作应自动迁移的数据。

- [ ] 在素材库点「导入书籍」，新建来源并导入测试 EPUB，核对书名、封面、插图及日文。分别在横排和竖排下检查连续滚动，用 `PageUp`／`PageDown` 或空格按视口移动。切换浅色／深色与宽／窄窗口后，检查正文完整、操作可达。
- [ ] 从「目录与书签」的两个页签及「本书搜索」分别跳转。在一段中间停留，刷新、离开再进入、关闭浏览器后重开，位置仍指向同一正文附近。重复文字不会跳到另一章。
- [ ] 鼠标划选含振假名和标点的原文，工具条定位可用；复制原文、带上下文复制和复制讲解提示词，粘贴到本地记事本，核对日文、换行、目标范围与上下文。无模型时仍能完成这些操作。
- [ ] 导入两份词典、重复导入同一份，核对安装项不重复；切换当前词典，正文与词卡内继续查词均显示当前词典的释义；检查含全角「ー」和半角「ｰ」长音符的词，词典有对应词条时能查到预期结果，记录所用原文和词条。
- [ ] 打开词卡后删除当前词典并明确选择替代词典，旧词卡关闭或更新；删除非当前词典，再删除最后一本，显示空状态。重启后不复活；同一 ZIP 可重新导入。若删除时旧查询仍在进行，完成后不得覆盖新词典结果；关闭页面或停止进程后检查文件占用已释放。
- [ ] 保存准备好的原句为学习片段，手写或粘贴一份含两节 Markdown 的讲解；编辑标题和正文后保存。从来源目录重新打开，核对内容；在“查看完整原文与资料”的原文及语境浮层内核对点击／Shift 悬浮和划选查词、长文滚动，以及 Escape 依次关闭子词卡、根词卡、资料浮层并恢复入口焦点。
- [ ] 将阅读位置移到另一章，停止并重启服务；从来源找到刚才的讲解，再点「在原文中定位」，应回到保存的章和原句。正文标记能打开同一份讲解。重复迁移后结果相同。

### 备份、恢复与版本替换

完成阅读与资料检查后停止应用，保留刚才的 EPUB、词典、片段与讲解。先定义两个尚不存在的目标目录，再按运行方式选择下面一组命令。

```powershell
$winBackup = Join-Path $winRoot '备份 01'
$winRestore = Join-Path $winRoot '恢复 数据 01'
```

源码版的源库仍由 `$env:FOLIO_J_DATABASE_PATH` 指定：

```powershell
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

冻结包使用以下命令，移除临时路径覆盖后，在选择页打开 `$winRestore` 中的已有库：

```powershell
.\Folio-J.exe data-path
.\Folio-J.exe backup $winBackup
.\Folio-J.exe restore $winBackup $winRestore
Remove-Item Env:FOLIO_J_DATABASE_PATH
.\Folio-J.exe start --choose-data
```

- [ ] 应用运行时尝试备份，明确拒绝；停止后备份和恢复成功，恢复路径不同于源库。恢复后核对书籍、阅读位置、书签、词典安装／选择、片段和讲解；原库仍在原处。
- [ ] 停止服务后，重复向已有备份目录备份、向已有恢复目录恢复，均拒绝覆盖；对测试目录里预建的空目录也应拒绝。
- [ ] 复制备份为另一份测试副本，截断副本中的 `app.db` 或修改 `manifest.json` 中的摘要，再恢复到全新目录，应明确失败且不留下可误当成功的新库。原备份与原库仍可使用。
- [ ] 将同一版本或待升级版本放到第二个独立程序目录，源码运行时重新安装依赖；冻结包保留完整目录结构。使用原测试库的绝对环境路径及同样端口配置。核对路径后迁移、启动，资料仍在；旧程序目录不必搬动。升级失败的回退使用升级前备份恢复到新目录，避免让旧版直接读已升级库。
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
| 验收日期与代码 | 日期；Git 提交号／RELEASE.json；BUILD.json dirty 状态；原始目录或 ZIP 解压包 |
| Windows 与终端 | Windows 11 构建号／x64；PowerShell、Python、Node、uv、pnpm、just 版本 |
| 浏览器与设备 | Chrome／Edge 版本、显示缩放、输入设备、日语声音 |
| 临时目录与端口 | 程序／源数据／恢复数据绝对路径；API／前端端口 |
| 本机自动验证 | 填写 Windows 实际命令、环境、原始目录与 ZIP 解压包各自的冒烟结果、跳过项及 Windows CI 链接 |
| 核心与设备结果 | 按上面各项记录结果；Windows 实机：尚未运行 |
| 下载与签名 | 如经实际下载，记录 Defender／SmartScreen 的拦截或提示，以及签名状态 |
| 跨系统与模型 | 对端系统／版本及恢复结果；可选模型测试是否执行与费用范围 |
| 问题与材料 | 复现步骤、退出码、脱敏日志和截图位置；后续复测结果 |

结束时停止测试服务，保留需要的验收记录、源码和临时数据。关闭专用终端即可清除本次环境变量。需要长期保留的资料移到自行管理的位置，临时目录可能被系统清理。
