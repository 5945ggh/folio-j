# 开发指南

本文维护本地开发环境、工程命令与仓库快照。首次试用见[项目首页](../README.md#快速开始)，应用配置见[使用指南](USAGE.md)，已有数据库的处理见[升级与备份](UPGRADING.md)。

参与开发前先读 [AGENTS.md](../AGENTS.md)。产品行为以 [PRD](PRD.md) 为准，当前实现与缺口见 [MVP 实施基线](handovers/MVP_IMPLEMENTATION_BASELINE.md)。

## 环境准备

准备 Python 3.11、Node.js 24、uv 和 pnpm 10。开发命令通过 `just` 统一调用，建议安装 `just`；仅试用应用可按[快速开始](../README.md#快速开始)中的直接命令运行。

Python 默认版本同时固定在根目录的 [.python-version](../.python-version) 和 [backend/.python-version](../backend/.python-version)，确保 `uv --project backend` 及后端目录内的命令使用同一版本。Python 包最低支持 3.11，Node 版本见 [.nvmrc](../.nvmrc)。依赖分别锁定在 [backend/uv.lock](../backend/uv.lock) 和 [frontend/pnpm-lock.yaml](../frontend/pnpm-lock.yaml)。

在仓库根目录运行：

```sh
just setup   # 安装锁定的后端与前端依赖
just dev     # 初始化／升级数据库，启动 FastAPI + Vite 热重载
```

开发页面为 [http://127.0.0.1:5173](http://127.0.0.1:5173)，API 文档为 [http://127.0.0.1:8000/api/docs](http://127.0.0.1:8000/api/docs)。`Ctrl-C` 一并停止前后端子进程。

后端绑定 `127.0.0.1`，数据保存在本地 SQLite。`just dev` 的前端代理随后端配置端口变化；端口和独立数据库的配置方式见[使用指南](USAGE.md#应用配置)。

## 常用命令

```sh
just lint         # Ruff、pyright strict、Biome、TypeScript 与原型语法检查
just test         # 后端与前端纯逻辑测试，禁止真实网络和模型调用
just gen-api      # 本地导出 OpenAPI 并生成前端类型，不需启动服务
just migrate      # 从空库建立当前 schema，或执行已有库的后续迁移
just start        # 初始化／升级数据库并构建前端，由 FastAPI 在 8000 端口托管（默认）
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

每次运行使用独立的 Chrome profile 与 Vite 缓存。设置 `BROWSER_TEST_SCREENSHOT_DIR=/绝对路径` 保存场景截图，文件名包含窗口宽高和完整查询身份，避免方向、主题或其他标记不同的场景相互覆盖。历史 `BROWSER_TEST_BASELINE` 仅用于下节的 Reader 测量，不用于普通回归或分享预览。

## 阅读会话性能测量

`node frontend/scripts/measure-reader.mjs --baseline` 在隔离 Vite 中读取本轮历史基线的阅读器模块；不切换工作树、不修改磁盘上的生产代码。省略 `--baseline` 测量当前实现。设置 `READER_MEASUREMENT_RUNS=3` 重复三次，默认覆盖 1280 和 390 宽度；通过 `BROWSER_TEST_QUERY='?suite=reader-session&direction=vertical-rl'` 可选择竖排。

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

## 仓库快照

运行 `just snapshot`（别名 `just snap`）可为远端 agent 生成仓库快照。需要 PATH 中已有 Repomix；它是可选开发工具，不加入项目锁定依赖。

快照自动保存在 `.snapshots/`，目录不存在时会创建。文件名为 `folio-j_仓库快照_YYYYMMDDHHMMSS.xml`，使用 XML 格式并显示文件树的 token 数量。Repomix 默认遵循 `.gitignore` 并检查敏感内容；整个快照目录已被忽略，不提交到 Git，也不打包进后续快照。

## 相关资料

- [文档导航](README.md)：产品需求、领域术语、架构和技术选型。
- [阶段性交接](handovers/README.md)：当前实施基线、后续安排与归档任务。
- [研究材料](../references/README.md)：可复核的原句、解析示例、提取和阅读实验。
- [第一阶段：素材与片段管理](handovers/archived/STAGE_1_SOURCE_SEGMENT.md)：该阶段已交付范围、接口和验收记录。

实验和原型保留各自的历史边界，不能据此恢复过时的产品需求。
