# 开发指南

本文维护本地开发环境、工程命令与仓库快照。首次试用见[项目首页](../README.md#快速开始)，应用配置见[使用指南](USAGE.md)，已有数据库的处理见[升级与备份](UPGRADING.md)。

参与开发前先读 [AGENTS.md](../AGENTS.md)。产品行为以 [PRD](PRD.md) 为准，当前实现与缺口见 [MVP 实施基线](handovers/MVP_IMPLEMENTATION_BASELINE.md)。

## 环境准备

准备 Python 3.11、Node.js 24、uv 和 pnpm 10.34.5。开发命令通过 `just` 统一调用，建议安装 `just`；仅试用应用可按[快速开始](../README.md#快速开始)中的直接命令运行。

Python 默认版本同时固定在根目录的 [.python-version](../.python-version) 和 [backend/.python-version](../backend/.python-version)，确保 `uv --project backend` 及后端目录内的命令使用同一版本。Python 包最低支持 3.11，Node 版本见 [.nvmrc](../.nvmrc)。依赖分别锁定在 [backend/uv.lock](../backend/uv.lock) 和 [frontend/pnpm-lock.yaml](../frontend/pnpm-lock.yaml)。

Windows 实验性支持以 Windows 11 x64、PowerShell 5.1／7 和 Chrome／Edge 为目标，推荐 `just 1.58` 或更新版本。`just setup/dev/start/lint/test/build/gen-api/migrate/backup/restore` 可使用原生命令入口；`snapshot` 的可选脚本仍要求 POSIX shell。本文其余行内环境变量赋值、`mktemp` 等示例使用 POSIX shell；PowerShell 的配置写法见[应用配置](USAGE.md#配置优先级与高级选项)，完整实机步骤见 [Windows 测试清单](handovers/WINDOWS_ACCEPTANCE.md)。

生产 `just start` 在构建后进入统一启动流程，首次通过页面选择默认 `~/Folio-J-Data` 或自定义目录，确认前不创建数据。`uv run --project backend python -m app.launcher start --choose-data` 可重开选择页，数据故障时保持恢复页。旧库与旧配置继续兼容，位置记忆优先级见[应用配置](USAGE.md#配置优先级与高级选项)。开发模式和显式 `just migrate` 仍直接使用解析出的路径；已有数据先按[升级与备份](UPGRADING.md)备份，测试用 `FOLIO_J_DATABASE_PATH` 指向独立库。

在仓库根目录运行：

```sh
just setup   # 仅安装锁定的后端与前端依赖，不读取学习库配置
just dev     # 初始化／升级数据库，启动 FastAPI + Vite 热重载
```

开发页面为 [http://127.0.0.1:5187](http://127.0.0.1:5187)，API 文档为 [http://127.0.0.1:8010/api/docs](http://127.0.0.1:8010/api/docs)。更改端口后以终端显示的访问地址为准，终端同时显示实际数据库路径。`Ctrl-C` 一并停止前后端子进程。

后端绑定 `127.0.0.1`，数据保存在本地 SQLite。`[server].port` 配置后端端口，`dev_port` 配置开发页面端口；`just dev` 的前端代理随后端配置端口变化。端口和独立数据库的配置方式见[使用指南](USAGE.md#应用配置)。

## 常用命令

```sh
just lint         # Ruff、pyright strict、Biome、TypeScript 与原型语法检查
just test         # 后端与前端纯逻辑测试，禁止真实网络和模型调用
just gen-api      # 本地导出 OpenAPI 并生成前端类型，不需启动服务
just migrate      # 从空库建立当前 schema，或执行已有库的后续迁移
just data-path    # 查看当前配置会使用哪个数据库
just start        # 构建前端，选择／恢复学习库并启动，默认 8010
just build        # 构建前端
just check-docs   # 检查公共文档本地路径，明确报告未核验的私有证据
just check-private-evidence # 同时核验本机私有证据，缺失时报错
just test-browser # 隔离 Chrome 中的真实组件与布局回归（可设置 CHROME_BIN）
just check        # lint + test + build + 文档链接 + 浏览器回归
just check-assets # 验证保留的实验和静态原型
```

`just` 或 `just --list` 列出可用命令，命令定义见 [justfile](../justfile)。

`just dev` 和 `just start` 使用同一后端端口，应选择一种运行方式；同一数据库只运行一个后台实例。两者都会先执行迁移，使用已有数据前须核对[升级与备份指南](UPGRADING.md)。

后端 schema 变化后运行 `just gen-api`，将 OpenAPI 与前端生成类型一并提交；不要手改生成类型。工程约束、测试规则及提交要求由 [AGENTS.md](../AGENTS.md) 维护。

## 文档与检查基准

`just check-docs` 检查根 README、AGENTS、全部 `docs/**/*.md`（含历史归档），以及研究和原型目录的 README。公共本地路径必须存在；解析后位于 `data/acceptance-evidence/` 的链接明确属于私有证据，默认只报告未核验数量。该目录保存本机原书截图和验收产物，不随 Git 分发，不能据公共检查通过声称这些证据存在。

持有相应证据时运行 `just check-private-evidence`：它同时检查公共链接和私有证据路径，任一缺失均失败。目录外的缺失路径不享有例外。两种检查都只校验本地路径，不验证标题锚点、外部 URL 或证据内容；修改这些引用时另行核对。

记录检查耗时时，在同一机器和依赖环境中顺序运行，避免与其他构建或测试争用资源。`PYTEST_ADDOPTS='--durations=20' just test` 可显示最慢的后端用例；前端测试输出总耗时。保留代码基准、命令、通过／失败及重跑原因，单次结果只用于定位候选瓶颈。浏览器定向回归选择方式见下节；完整检查入口仍为 `just check`。

## 浏览器定向回归

`BROWSER_TEST_SUITE=reader-layout-switch just test-browser` 运行该组的所有窗口与方向组合。`BROWSER_TEST_QUERY='?direction=vertical-rl&suite=reader-session' just test-browser` 按完整查询选择场景，参数顺序和空值标记的写法不影响匹配。两个筛选同时设置时取交集；没有匹配场景会在启动 Chrome 前失败。完成后输出实际通过场数。

每次运行使用独立的 Chrome profile 与 Vite 缓存。设置 `BROWSER_TEST_SCREENSHOT_DIR=/绝对路径` 保存场景截图，文件名包含窗口宽高和完整查询身份，避免方向、主题或其他标记不同的场景相互覆盖。历史 `BROWSER_TEST_BASELINE` 仅用于[阅读会话性能测量](#阅读会话性能测量)。

## Windows 自动验证

[Windows workflow](../.github/workflows/windows.yml) 在 `windows-2025` runner 上安装锁定依赖，先执行静态检查与进程生命周期定向回归，再执行完整后端与前端测试、生产构建、Chrome／Edge 定向组件回归，并打包当前提交后运行源码 ZIP 冒烟脚本。独立的冻结包任务使用生产依赖与 `packaging` 组构建 Windows ZIP，分别对原始目录和 ZIP 解压目录运行冻结包冒烟，上传目录包、构建信息及对应源码。工作流可从 Actions 手动触发，也随 PR、`main` 和 `codex/windows-*` 分支推送运行。配置存在不表示远端执行已通过，结果见 [Windows 验收记录](handovers/WINDOWS_ACCEPTANCE.md)。

源码包冒烟使用独立中文与空格目录、临时 HOME／USERPROFILE 和新数据库，验证迁移、真实服务启动与停止、离线备份、拒绝覆盖已有目标、恢复后重启，不调用模型。已安装 `uv`、`pnpm`、`just` 时可在本机复现：

```sh
uv run --project backend python scripts/smoke_source.py /绝对路径/Folio-J-review.zip
```

浏览器工具自动寻找本机 Chrome／Edge，也可设置 `CHROME_BIN`。后端性能测量脚本在 Windows 上将不具备的 RSS 峰值返回为 `null`；历史性能基准与设备阅读体验仍需分别验证。

`just test` 包含 Windows 开发模式的热重载与退出回归，通过临时 ASGI 应用的关闭屏障核对清理顺序；Windows 控制台事件及 Job Object 检查须在 Windows 原生执行。Windows 正常停止会等待后端清理完成，第二次 Ctrl-C 不截断清理。若后端清理卡住，可在任务管理器结束本次启动器，由 Job Object 清理其子进程，再检查端口并重启。

## 真实学习闭环验收

用实际浏览器、FastAPI 和临时 SQLite 库验证从 EPUB 保存片段、写入讲解、重启后找回讲解并返回原句的流程。样书 [synthetic-reading.epub](../backend/tests/fixtures/epub/synthetic-reading.epub) 随 Git 提供，书名为「日語定位合成樣書」。全程使用人工讲解，无需模型配置。

### 启动临时实例

在仓库根目录打开专用终端。首次检出先执行 `just setup` 安装锁定依赖，然后运行以下命令。记下打印的临时目录，稍后重启时使用。

```sh
just build
loop_dir=$(mktemp -d /tmp/folio-j-learning.XXXXXXXX)
printf '验收目录 %s\n' "$loop_dir"
```

直接导入仓库中的样书即可。如需重新生成，在同一终端运行 `python3 scripts/make_epub_fixtures.py --output "$loop_dir/books"`，选用其中的 `synthetic-reading.epub`。

```sh
FOLIO_J_DATABASE_PATH="${loop_dir:?}/learning.db" just migrate &&
  FOLIO_J_DATABASE_PATH="$loop_dir/learning.db" uv run --project backend uvicorn app.main:app --host 127.0.0.1 --port 8017
```

等终端显示 `Uvicorn running on http://127.0.0.1:8017` 后，打开[验收实例](http://127.0.0.1:8017)，确认素材库为空。若启动时提示端口已被使用，启动、重启及浏览器地址都换成同一个空闲端口。

### 保存片段和讲解

1. 在素材库点「导入 EPUB」，选上面的样书。点「新建来源」，命名为「闭环验收」，创建来源后点「导入」。等准备完成，点书卡开始阅读。
2. 从底部「目录」进入「第二章」。在「次の章でも日本語を読む。」下方，用鼠标划选完整的 **引用の文章。**，包括句号。点选区工具条的「保存」，核对目标原文后点「保存片段」。从保存提示点「打开片段 →」。若提示已消失，点刚保存的正文标记，再从预览打开片段。
3. 选「＋ 新建讲解 → 编写或粘贴讲解」，标题填 `引用の文章・回读`，粘贴下面两段 Markdown，点「保存讲解」。确认讲解页显示标题及两段内容。

   ```markdown
   ## 句意
   引用的文字。

   ## 表达
   「の」连接「引用」和「文章」。
   ```

4. 点片段出处的「在原文中定位 →」，回到书中后点「上一章」。看到「第一章」和「同じ言葉。」后，从阅读器左上角返回并关闭验收标签页。此时最后阅读的章与片段出处不同。

### 重启后从来源找回

在运行服务的终端按 `Ctrl-C`，等服务退出。在**同一终端、仓库根目录**执行下面的命令。若换了终端，先把 `loop_dir` 设为刚才打印的绝对目录。`test -s` 确认原数据库存在且非空，成功后才启动服务。

```sh
test -s "${loop_dir:?}/learning.db" &&
  FOLIO_J_DATABASE_PATH="$loop_dir/learning.db" uv run --project backend uvicorn app.main:app --host 127.0.0.1 --port 8017
```

1. 新开标签页访问验收实例首页，从主导航进入「来源目录 → 闭环验收」。在概览的「最近更新的讲解」打开 `引用の文章・回读`。核对片段原文为「引用の文章。」，讲解中「句意」和「表达」下的文字与保存时一致。
2. 点材料出处的「在原文中定位 →」。阅读器应打开「日語定位合成樣書」的「第二章」，被标记的是「次の章でも日本語を読む。」下方的「引用の文章。」整句。点这处正文标记，确认能就地预览同一标题和讲解内容。

验收结束后按 `Ctrl-C` 停止临时实例。保留打印的目录即可再次打开这次的资料。

## 阅读会话性能测量

`node frontend/scripts/measure-reader.mjs` 测量当前实现。加 `--baseline` 时，隔离 Vite 从固定提交 `ae44fc8` 读取 `MaterialReader.tsx`、`reader-frames.ts`、`study-marks-query.ts` 和 `chapter-translations-query.ts`，在内存中替换这四个模块；其余代码、依赖与离线夹具沿用当前版本，不切换工作树或修改生产文件。这是 2026-10-24 阅读会话保留优化的局部历史对照，不代表完整旧版应用；本地 Git 必须包含该提交及四个文件，浅克隆或源码 ZIP 可能不具备。日常测量使用当前模式即可。

设置 `READER_MEASUREMENT_RUNS=3` 重复三次，默认覆盖 1280 和 390 宽度；通过 `BROWSER_TEST_QUERY='?suite=reader-session&direction=vertical-rl'` 可选择竖排。

测量使用离线接口夹具和真实 Chrome DOM 时钟，输出材料／出处／注音准备／章节请求的相对时间、iframe 呈现时间、可读与保存状态，以及 iframe／Document 身份是否复用；夹具响应耗时不能代表真实后端或模型耗时。验收与比较口径见[阅读会话记录](handovers/archived/text-study/READER_SESSION_ACCEPTANCE.md)，复用接口与生命周期见[架构](ARCHITECTURE.md#312-阅读器-r11-呈现与只读派生查询)。

## 后端细粒度读取测量

`scripts/measure_reader_backend.py` 在临时 SQLite 中测量位置保存、单章注音及首／中／末图片读取。默认采用 `scripts/reader_measurement_baseline.py` 中冻结自 `7747434` 的三条服务流程；加 `--reader-views` 测量当前生产读取视图。冻结对照与当前实现共用模型、解码器和纯投影／进度规则，仅用于测量，不被生产代码调用。

```sh
uv run --project backend python scripts/measure_reader_backend.py --output /tmp/reader-baseline.json --repeats 3
uv run --project backend python scripts/measure_reader_backend.py --reader-views --output /tmp/reader-views.json --repeats 3
```

默认覆盖三种确定性合成书和 4 请求并发；`--sizes small` 可缩小范围。`--epub /绝对路径/样书.epub` 额外读取本地样书，报告只含规模、摘要和指标；不会访问用户数据库或模型。`--chapter-selection largest` 改用跨度最长的正文章，默认 `first` 选择首个含正文的章。

耗时不包含 HTTP 序列化、浏览器或 fixture 构造；冷请求指新建读取视图实例，OS／SQLite 页缓存仍可能热。latency 与 tracemalloc 分开测量；冷峰值包含缓存建立，冷后存活值在释放响应并 GC 后记录，暖峰值只计本次新增分配，不能当作总内存。RSS 是整个测量进程的高水位，包含 fixture 构造。比较时顺序运行两组并避免同时构建或测试。结果与取舍见[后端读取性能验收](handovers/archived/READER_READ_PERFORMANCE_ACCEPTANCE.md)。

## 生产页面冷加载测量

`just build` 后运行 `node frontend/scripts/measure-loading.mjs`，在隔离 Chrome 中测量生产素材库与学习偏好页。脚本使用本机静态服务器与离线 API，每次新建浏览器上下文并禁用 HTTP 缓存，默认各跑五次；`LOADING_MEASUREMENT_RUNS` 可设为 1–20。输出实际 JS／CSS 响应体大小、逐文件 gzip 估值、首个内容绘制和目标表单／空库内容出现时间，不访问用户数据库或模型。

可以传入两个已有构建目录：`node frontend/scripts/measure-loading.mjs /path/to/baseline-dist /path/to/current-dist`。脚本交替测量两份产物，不修改构建或源代码；应在相同依赖与运行环境下生成两份构建。比较口径、首次异步页面的等待代价及结果见[路由加载验收](handovers/archived/ROUTE_LOADING_ACCEPTANCE.md)。

## 构建供试用的源码包

在开发仓库中，从准备交付的提交生成供审阅的 ZIP。先创建输出目录，使用一个尚不存在的文件名。下面以当前已提交的 HEAD 为例。

```sh
mkdir -p dist
python3 scripts/package_release.py --ref HEAD --version 0.1.0+candidate.1 --output dist/Folio-J-review.zip
```

正式打包时将 `--ref` 设为确切的发布 tag，省略 `--version` 即从 tag 取版本号。打包器读取该提交中的[文件清单](../scripts/release/manifest.json)、源码和用户文档，并生成记录提交号和版本名的 `RELEASE.json`。调整[发行包首页](../scripts/release/README.md)或用户指南后，先提交再重新生成。发布前在解压目录核对包内 Markdown 的相对路径和标题锚点；仓库的文档检查无法发现包中未分发的目标。

验收使用两份独立解压目录和临时数据。在第一份中按包内首页安装、导入原创合成 EPUB、保存书签和有精确出处的讲解，停止服务后用包内命令备份。在第二份中恢复到新位置，再打开讲解并定位到同一句。已有词典和凭据时同时核对，并验证拒绝覆盖已有目标。发布样本只使用合成数据，留作后续版本迁移恢复的输入。

源码 ZIP 与实验目录包均须包含根目录的 `LICENSE` 和 `COPYING.md`。发布前核对两文件内容及包内首页链接。二进制发行还须在下载处提供对应版本的完整源码与必要构建脚本；含未提交修改的实验包不能只用 `RELEASE.json` 中的提交号代表对应源码。授权范围见[授权声明](../COPYING.md)。

## 实验目录包

目录包在构建机器上预构建前端、捆绑 Python 与生产依赖，使用者直接启动本机服务并在系统浏览器中使用，无需安装 Python 或 Node.js。目前是本机试做，不替代公开 beta 的源码 ZIP；跨系统与架构需要分别构建和验证。

先构建同一工作区的前端，再用独立环境安装锁定的生产依赖与 `packaging` 组。输出目录必须尚不存在。POSIX shell：

```sh
pnpm --dir frontend install --frozen-lockfile
pnpm --dir frontend build
UV_PROJECT_ENVIRONMENT="$PWD/.cache/frozen/venv" uv sync --project backend --locked --no-dev --group packaging
.cache/frozen/venv/bin/python scripts/package_frozen.py --version 0.1.0-frozen-trial.4 --output dist/frozen-trial.4
.cache/frozen/venv/bin/python scripts/smoke_frozen.py dist/frozen-trial.4/Folio-J
```

### Windows 原生构建

在 Windows 11 x64 上准备 Git、Python 3.11、Node.js 24、uv、pnpm 10.34.5，用 PowerShell 在完整 Git 仓库根目录执行；无需安装 just。已安装 Corepack 时可用 `corepack prepare pnpm@10.34.5 --activate` 选择 pnpm 版本。构建器读取 Git 提交号和工作区状态，不能只复制源码文件后省略 `.git`。

若从另一台机器转移源码，先将待交付修改提交并合入本地 `main`，再生成 bundle；远端推送不是必要步骤：

```sh
mkdir -p dist
git bundle create dist/folio-j-main.bundle main
git rev-parse main
```

bundle 保存已提交的 `main` 及其历史，不包含未提交修改、未跟踪的本地原型、依赖或学习数据。将 bundle 复制到 Windows，核对来源提交号。新目录用 `git clone --branch main C:\转移\folio-j-main.bundle C:\项目\folio-j`；已有仓库先确认工作区干净，再更新本地 `main`：

```powershell
git fetch C:\转移\folio-j-main.bundle main
if ($LASTEXITCODE -ne 0) { throw 'bundle 读取失败' }
git switch main
if ($LASTEXITCODE -ne 0) { throw '切换 main 失败' }
git merge --ff-only FETCH_HEAD
if ($LASTEXITCODE -ne 0) { throw 'main 无法快进，请先处理分支差异' }
git rev-parse HEAD
```

若不能快进，先处理本地分支差异，不用强制重置覆盖工作。在仓库根目录执行下面的构建块。它在每步失败后停止，并在成功或失败时恢复环境变量；输出目录已存在时须换一个新的版本和目录。

```powershell
$frozenUseMirror = $false # 国内下载备用：改为 $true
$frozenVersion = '0.1.0-win-trial.2'
$frozenOutput = 'dist/win-trial.2'
$frozenPreviousEnvironment = $env:UV_PROJECT_ENVIRONMENT
$frozenPreviousIndex = $env:UV_DEFAULT_INDEX
try {
    if (Test-Path $frozenOutput) { throw "输出目录已存在：$frozenOutput" }
    pnpm --dir frontend install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw '前端依赖安装失败' }
    pnpm --dir frontend build
    if ($LASTEXITCODE -ne 0) { throw '前端构建失败' }
    # 保持锁文件中的源配置，退出时恢复原覆盖。
    Remove-Item Env:UV_DEFAULT_INDEX -ErrorAction SilentlyContinue
    if ($frozenUseMirror) {
        New-Item -ItemType Directory -Force .cache/frozen -ErrorAction Stop | Out-Null
        uv export --project backend --locked --no-dev --group packaging --format requirements-txt --no-emit-project --output-file .cache/frozen/requirements.txt
        if ($LASTEXITCODE -ne 0) { throw '锁定依赖导出失败' }
        $env:UV_PROJECT_ENVIRONMENT = Join-Path (Get-Location).Path '.cache/frozen/venv-mirror'
        if (Test-Path $env:UV_PROJECT_ENVIRONMENT) { throw '请为镜像构建选择新的虚拟环境目录' }
        uv venv --python 3.11 $env:UV_PROJECT_ENVIRONMENT
        if ($LASTEXITCODE -ne 0) { throw '构建环境创建失败' }
        $frozenPython = Join-Path $env:UV_PROJECT_ENVIRONMENT 'Scripts/python.exe'
        uv pip install --python $frozenPython --require-hashes --default-index https://pypi.tuna.tsinghua.edu.cn/simple -r .cache/frozen/requirements.txt
        if ($LASTEXITCODE -ne 0) { throw '镜像依赖安装或 hash 校验失败' }
    } else {
        $env:UV_PROJECT_ENVIRONMENT = Join-Path (Get-Location).Path '.cache/frozen/venv'
        uv sync --project backend --python 3.11 --locked --no-dev --group packaging
        if ($LASTEXITCODE -ne 0) { throw '锁定依赖安装失败' }
        $frozenPython = Join-Path $env:UV_PROJECT_ENVIRONMENT 'Scripts/python.exe'
    }
    & $frozenPython scripts/package_frozen.py --version $frozenVersion --output $frozenOutput
    if ($LASTEXITCODE -ne 0) { throw '冻结包构建失败' }
    & $frozenPython scripts/smoke_frozen.py (Join-Path $frozenOutput 'Folio-J')
    if ($LASTEXITCODE -ne 0) { throw '原始目录包冒烟失败' }
} finally {
    if ($null -eq $frozenPreviousEnvironment) { Remove-Item Env:UV_PROJECT_ENVIRONMENT -ErrorAction SilentlyContinue }
    else { $env:UV_PROJECT_ENVIRONMENT = $frozenPreviousEnvironment }
    if ($null -eq $frozenPreviousIndex) { Remove-Item Env:UV_DEFAULT_INDEX -ErrorAction SilentlyContinue }
    else { $env:UV_DEFAULT_INDEX = $frozenPreviousIndex }
}
```

#### 国内下载备用

默认安装无法下载时，将上面构建块的 `$frozenUseMirror` 改为 `$true`。备用分支使用新的独立环境，从同一锁文件导出带 hash 的依赖，再只对安装命令使用清华镜像。前端下载受限时，可对上面 `pnpm install` 单次加 `--registry=https://registry.npmmirror.com`，仍保留 `--frozen-lockfile`。这些选项不修改项目默认源与锁文件。

临时设置 `UV_DEFAULT_INDEX` 会改变锁文件的源配置，导致 `uv sync --locked`／`uv export --locked` 要求更新锁；构建块会暂时移除该覆盖，退出时恢复，不用重锁解决下载问题。`uv export` 默认保留 hash，勿加 `--no-hashes`；`--output-file` 避免 PowerShell 重定向改变文件编码。`--no-emit-project` 省去本地项目安装，构建器已通过 PyInstaller 的 `--paths backend/src` 收集应用。镜像必须提供与锁文件 hash 相符的文件；缺失时保留错误，换用可访问的源，不移除 hash 校验。

#### 最终 ZIP 解压验证

原始目录包冒烟通过后，在同一 PowerShell 中解压唯一的 ZIP 到新中文空格目录，再运行未修改的冒烟脚本；`$frozenPython` 仍指向刚才使用的构建环境：

```powershell
$frozenArchives = @(Get-ChildItem -LiteralPath $frozenOutput -Filter '*.zip' -File)
if ($frozenArchives.Count -ne 1) { throw '应只有一个 Windows 目录包 ZIP' }
$frozenExtracted = Join-Path $env:TEMP ('Folio-J 解压验收 ' + [guid]::NewGuid().ToString('N'))
Expand-Archive -LiteralPath $frozenArchives[0].FullName -DestinationPath $frozenExtracted -ErrorAction Stop
& $frozenPython scripts/smoke_frozen.py (Join-Path $frozenExtracted 'Folio-J')
if ($LASTEXITCODE -ne 0) { throw 'ZIP 解压包冒烟失败' }
Get-FileHash -LiteralPath $frozenArchives[0].FullName -Algorithm SHA256
```

### 产物与验收范围

打包器读取当前工作区，前端产物须由同一工作区刚刚构建。`RELEASE.json` 保留版本与提交号，`BUILD.json` 另记工作区是否有改动、平台、Python、PyInstaller 与分词词典版本；不能将未提交实验包当作对应提交的正式发行。输出包含 `Folio-J/`、Windows 原生 ZIP（其他平台为保留符号链接和执行权限的 `.tar.gz`）与 `SIZE.json`。第三方许可证随目录保存。构建环境与缓存不属于交付内容；分发二进制时同时提供对应源码和构建脚本。

用户进入完整的 `Folio-J/` 目录后，先运行 `./Folio-J data-path` 核对学习库，再运行 `./Folio-J start`；Windows 使用 `.\Folio-J.exe`。`data-path` 不创建数据库。`start --no-browser` 只启动服务；`Ctrl-C` 停止。`backup <新目录>`、`restore <备份目录> <新恢复目录>` 沿用[数据与凭据保护规则](UPGRADING.md#数据与凭据)，恢复后仍须将用户配置指向恢复库。完整操作说明也放在包内首页。

`smoke_frozen.py` 将产物复制并移位到中文空格临时目录，在无 Python／Node PATH、独立 HOME 下验证含 emoji 和罕字的数据／备份／恢复路径、管道 UTF-8 输出、真实 HTTP、分词资源、持久学习内容及备份恢复，并在 Windows 检查 CTRL_BREAK 退出；只访问 loopback，不调用真实模型。该检查覆盖服务与数据流程，阅读排版、浮层和浏览器操作仍按 [Windows 实机清单](handovers/WINDOWS_ACCEPTANCE.md)验证。早期本机尺寸与检查结果见[PyInstaller 验收记录](handovers/archived/PYINSTALLER_ACCEPTANCE.md)，本批状态见[实施基线](handovers/MVP_IMPLEMENTATION_BASELINE.md)。

## 仓库快照

运行 `just snapshot`（别名 `just snap`）可为远端 agent 生成仓库快照。需要 PATH 中已有 Repomix；它是可选开发工具，不加入项目锁定依赖。

快照自动保存在 `.snapshots/`，目录不存在时会创建。文件名为 `folio-j_仓库快照_YYYYMMDDHHMMSS.xml`，使用 XML 格式并显示文件树的 token 数量。Repomix 默认遵循 `.gitignore` 并检查敏感内容；整个快照目录已被忽略，不提交到 Git，也不打包进后续快照。

## 日常收尾与本地产物

功能合入并推送后，确认提交或等价改动已进入 `main`，再清理对应的本地、远端功能分支与工作树；先核对未提交、未跟踪及忽略文件，并确认其他工作树的分支占用。提交整理与分支约定见 [AGENTS](../AGENTS.md#提交约定)。

由锁文件重建的依赖环境、构建缓存和普通仓库快照可按需清理，先确认无进程占用且无独有内容。恢复备份、数据库、凭据和独有草稿须确认保留位置与恢复用途后再处理；普通仓库快照不能代替[数据备份](UPGRADING.md#制作备份)。

## 相关资料

- [文档导航](README.md)：产品需求、领域术语、架构和技术选型。
- [阶段性交接](handovers/README.md)：当前实施基线、后续安排与归档任务。
- [研究材料](../references/README.md)：可复核的原句、解析示例、提取和阅读实验。
- [第一阶段：素材与片段管理](handovers/archived/STAGE_1_SOURCE_SEGMENT.md)：该阶段已交付范围、接口和验收记录。

实验和原型保留各自的历史边界，不能据此恢复过时的产品需求。
