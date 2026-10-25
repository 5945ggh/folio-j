# 开发指南

本文维护本地开发环境、工程命令与仓库快照。首次试用见[项目首页](../README.md#快速开始)，应用配置见[使用指南](USAGE.md)，已有数据库的处理见[升级与备份](UPGRADING.md)。

参与开发前先读 [AGENTS.md](../AGENTS.md)。产品行为以 [PRD](PRD.md) 为准，当前实现与缺口见 [MVP 实施基线](handovers/MVP_IMPLEMENTATION_BASELINE.md)。

## 环境准备

准备 Python 3.11、Node.js 24、uv、pnpm 10 和 just。

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
just check-docs   # 检查文档本地链接
just test-browser # 隔离 Chrome 中的真实组件与布局回归（可设置 CHROME_BIN）
just check        # lint + test + build + 文档链接 + 浏览器回归
just check-assets # 验证保留的实验和静态原型
```

`just` 或 `just --list` 列出可用命令，命令定义见 [justfile](../justfile)。

`just dev` 和 `just start` 使用同一后端端口，应选择一种运行方式；同一数据库只运行一个后台实例。两者都会先执行迁移，使用已有数据前须核对[升级与备份指南](UPGRADING.md)。

后端 schema 变化后运行 `just gen-api`，将 OpenAPI 与前端生成类型一并提交；不要手改生成类型。工程约束、测试规则及提交要求由 [AGENTS.md](../AGENTS.md) 维护。

## 阅读会话性能测量

`node frontend/scripts/measure-reader.mjs --baseline` 在隔离 Vite 中读取本轮历史基线的阅读器模块；不切换工作树、不修改磁盘上的生产代码。省略 `--baseline` 测量当前实现。设置 `READER_MEASUREMENT_RUNS=3` 重复三次，默认覆盖 1280 和 390 宽度；通过 `BROWSER_TEST_QUERY='?suite=reader-session&direction=vertical-rl'` 可选择竖排。

测量使用离线接口夹具和真实 Chrome DOM 时钟，输出材料／出处／注音准备／章节请求的相对时间、iframe 呈现时间、可读与保存状态，以及 iframe／Document 身份是否复用；夹具响应耗时不能代表真实后端或模型耗时。验收与比较口径见[阅读会话记录](handovers/text-study/READER_SESSION_ACCEPTANCE.md)，复用接口与生命周期见[架构](ARCHITECTURE.md#312-阅读器-r11-呈现与只读派生查询)。

## 生产页面冷加载测量

`just build` 后运行 `node frontend/scripts/measure-loading.mjs`，在隔离 Chrome 中测量生产素材库与学习偏好页。脚本使用本机静态服务器与离线 API，每次新建浏览器上下文并禁用 HTTP 缓存，默认各跑五次；`LOADING_MEASUREMENT_RUNS` 可设为 1–20。输出实际 JS／CSS 响应体大小、逐文件 gzip 估值、首个内容绘制和目标表单／空库内容出现时间，不访问用户数据库或模型。

可以传入两个已有构建目录：`node frontend/scripts/measure-loading.mjs /path/to/baseline-dist /path/to/current-dist`。脚本交替测量两份产物，不修改构建或源代码；应在相同依赖与运行环境下生成两份构建。比较口径、首次异步页面的等待代价及结果见[路由加载验收](handovers/ROUTE_LOADING_ACCEPTANCE.md)。

## 仓库快照

运行 `just snapshot`（别名 `just snap`）可为远端 agent 生成仓库快照。需要 PATH 中已有 Repomix；它是可选开发工具，不加入项目锁定依赖。

快照自动保存在 `.snapshots/`，目录不存在时会创建。文件名为 `folio-j_仓库快照_YYYYMMDDHHMMSS.xml`，使用 XML 格式并显示文件树的 token 数量。Repomix 默认遵循 `.gitignore` 并检查敏感内容；整个快照目录已被忽略，不提交到 Git，也不打包进后续快照。

## 相关资料

- [文档导航](README.md)：产品需求、领域术语、架构和技术选型。
- [阶段性交接](handovers/README.md)：当前实施基线、后续安排与归档任务。
- [研究材料](../references/README.md)：可复核的原句、解析示例、提取和阅读实验。
- [第一阶段：素材与片段管理](handovers/archived/STAGE_1_SOURCE_SEGMENT.md)：该阶段已交付范围、接口和验收记录。
- [工作台视觉基线](../prototypes/reading-native/VISUAL_BASELINE.md)：正式界面的风格与布局参考；具体交互按实际功能设计，原型中的模拟行为不替代 PRD。

实验和原型保留各自的历史边界，不能据此恢复过时的产品需求。
