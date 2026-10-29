# 技术选型

> 选型草案 v0.3。表中区分已采用技术与预留选型，实际依赖以锁文件为准。
> 选型原则：
> 1. 优先选择主流、AI 训练语料充分的方案（coding agent 友好）；
> 2. 前后端之间只有一份类型契约（OpenAPI）；
> 3. 零额外运维组件，不引入 Redis、独立数据库服务或消息队列；
> 4. 本地优先，但架构不排斥日后部署到服务器或打包为桌面应用。
>
> 版本策略：项目初始化时取各依赖的最新稳定版，由 lockfile（`uv.lock`、`pnpm-lock.yaml`）锁定；升级需显式进行。

当前工程锁文件为 `backend/uv.lock` 和 `frontend/pnpm-lock.yaml`。开发环境使用 Python 3.11、Node.js 24，Python 包最低支持 3.11；实际依赖以锁文件为准。已采用 `openai` 官方 SDK、Jinja2、markdown-it-py、hypothesis、react-markdown 与 remark-gfm，覆盖模型协议、提示词模板、规范化与性质测试、讲解渲染；SudachiPy 与 SudachiDict-core 用于分词与全量注音。SSE、shadcn/ui 与 Zustand 尚未引入。

基础运行补充依赖：Uvicorn 承载 ASGI 服务，httpx 通过本地 ASGI transport 测试 API，Hatchling 构建 Python 的 src 布局包。前端 TypeScript 暂锁 5.9.3，以满足所选 openapi-typescript 7.x 的 peer 范围；Node 类型锁在 24 系列，与运行时一致。Tailwind 使用官方 Vite 插件，不提前引入未使用的 shadcn 组件或 Zustand。

## 1. 后端（Python）

| 用途 | 选择 | 说明 |
|---|---|---|
| 语言 | Python ≥ 3.11 | 开发期使用 Python；稳定后可能用其他语言重写，因此业务逻辑应减少依赖 Python 特有的"魔法" |
| 环境与包管理 | uv | 所有命令都通过 `uv run` 执行 |
| Web 框架 | FastAPI | 自动生成 OpenAPI，作为前端类型的唯一来源 |
| 数据校验 | Pydantic v2 | 同时用于 API schema、LLM 结构化输出 schema 和配置模型 |
| ORM | SQLAlchemy 2.0（`Mapped` 类型化风格） | 不使用 SQLModel；ORM 模型与 API schema 分开定义 |
| 迁移 | Alembic | 固定 DDL 基线支持空库重建，并保留后续增量迁移基础；迁移链、事务与旧库边界见[架构](ARCHITECTURE.md#3-领域模型) |
| 数据库 | SQLite（WAL 模式） | 已采用；积累库检索尚未实现，选型保留 MVP 用 `LIKE`、P1 用 FTS5、远期用 sqlite-vec。运行中的 WAL 数据库备份须保证一致性，不能仅复制主文件 |
| SSE | sse-starlette（预留，未安装） | 当前页面轮询持久 Run／Job；模型侧流式响应不等于浏览器已采用 SSE |
| LLM 客户端 | `openai` 官方 Python SDK，通过 `base_url` 对接 | BYOK、多 Provider；适配 OpenAI 兼容的 Chat Completions 与 Responses 文本调用 |
| Prompt 模板 | Jinja2 | 模板以文件形式放在 `backend/prompts/`，文件头部标注版本号 |
| Markdown 解析 | markdown-it-py | 规范化器用它获取标题 token 及其行号映射 |
| 日语分词 | SudachiPy + SudachiDict-core，A 粒度切分 | 已采用；使用本地词典，不调用模型，不使用 UniDic |
| 配置 | 应用运行配置使用 TOML + Pydantic；模型接入设置通过 UI 维护 | 已采用；Provider／模型／用途默认值保存在 SQLite，凭据保存在数据库旁私有目录，不将 providers.toml 设为唯一入口 |
| ID | ULID（当前由 `app/ids.py` 实现） | 已用于主键和 Section uid；未安装 `python-ulid` |
| 后台任务 | SQLite `chat_jobs` 表（领域 Job）+ 进程内 asyncio worker | 问答与讲解共用执行机制；模型调用记录存于 `runs` |
| 测试 | pytest、pytest-asyncio、hypothesis | 用 hypothesis 对规范化器做"可复原"的性质测试 |
| 静态检查 | ruff（lint + format）、pyright（strict） | |

分词结果使用 SQLite 中的压缩 JSON，复用标准库能力；版本、发布及定位隔离见[全量注音与分词资产](ARCHITECTURE.md#313-全量注音与分词资产)。

EPUB 编译使用标准库 ZIP／XML／HTML 处理与 Pydantic 定义产物，不引入阅读器引擎。原 EPUB 与压缩编译包保存为 SQLite BLOB，避免外置文件的双提交；编译包使用标准库 zlib 与共享图片字符串池无损编码。编译、存储格式、安全预算及删除回收见[架构实体契约](ARCHITECTURE.md#31-实体)。

封面使用标准库校验静态 PNG／JPEG 的头部与结构，不引入图像解码库；支持范围、候选回退与独立于正文图片的安全预算见[目录与材料使用状态](ARCHITECTURE.md#311-目录与材料使用状态)。

搜索与图库从编译包派生，暂不引入持久检索索引；接口与并发机制见[阅读器只读派生查询](ARCHITECTURE.md#312-阅读器-r11-呈现与只读派生查询)。

## 2. 前端

文本分析与书籍统计沿用 Sudachi、Pydantic、SQLite、asyncio 和前端 SVG，不新增依赖或外部服务；计算、缓存及并发契约见[文本分析与统计](ARCHITECTURE.md#314-文本分析与统计契约)。

| 用途 | 选择 | 说明 |
|---|---|---|
| 构建 | Vite | 纯 SPA；**不用 Next.js**：不需要 SSR，而且会增加打包与部署的复杂度 |
| 语言与框架 | TypeScript（strict）+ React | |
| 样式与组件 | Tailwind CSS、原生 CSS 语义变量与 `light-dark()` 已采用；shadcn/ui 预留 | 颜色由局部 `color-scheme` 解析，规则见[设计系统](DESIGN_SYSTEM.md)；当前无已引入的 shadcn 组件 |
| 服务端状态 | TanStack Query | 所有 API 数据都经由它获取和缓存 |
| 本地 UI 状态 | React 组件 state；Zustand 预留，未安装 | 能用组件 state 解决的就不引入 |
| 路由 | React Router（library 的 Data router）`[TBD-13]` | RouterProvider 承载现有组件路由，供设置草稿使用 useBlocker；不使用 framework 模式，服务端数据仍由 TanStack Query 管理 |
| API 客户端 | openapi-typescript + openapi-fetch | 由后端 OpenAPI 生成，**禁止手写接口类型** |
| Markdown 渲染 | react-markdown + remark-gfm | |
| Lint 与格式化 | Biome `[TBD-13]` | 单一工具，配置简单 |
| 单元测试 | Node.js 内置测试；Vitest 按需 | 当前用 Node.js 24 直接运行 TypeScript 纯逻辑测试，不引入前端测试依赖；组件测试框架按需添加 |
| E2E | 暂不引入 | 由 coding agent 自带的浏览器能力做界面验证；以后需要再加 Playwright |
| 包管理 | pnpm | Node 使用当前 LTS 版本 |

Reader 使用无脚本同源 iframe 和 CSP／sandbox 隔离作者样式，搜索高亮使用 DOM Range／CSS Highlight；外壳适配与定位机制见[架构](ARCHITECTURE.md#312-阅读器-r11-呈现与只读派生查询)。应用外观使用浏览器 Storage、`matchMedia`、React `useSyncExternalStore` 与启动脚本，不引入主题库；配色与 iframe 桥接见[前端结构](ARCHITECTURE.md#6-前端结构)。交互参数由[阅读与导航](INFORMATION_ARCHITECTURE.md)维护，实际兼容性验证见[实施基线](handovers/MVP_IMPLEMENTATION_BASELINE.md)。

## 3. 模型接入（BYOK）

产品设置行为见[PRD F1](PRD.md#f1-设置)，权限与反馈见[F9](PRD.md#f9-agent-工具权限与审核)、[F8](PRD.md#f8-状态与诊断)。技术接入区分 Provider、模型、调用协议及用途默认值，不将用途和协议混为一谈。

接入范围与实现机制见[LLM 层](ARCHITECTURE.md#42-llm-层llm)。Occurrence 候选、结构化提取及复杂组合恢复仍为未来约束，不能从支持文本或 Analysis 工具调用推断这些能力已经可用。

- 使用 `openai` SDK 适配 OpenAI 兼容的 `chat_completions` 与 `responses` 两种文本协议，分别转换请求、解析响应与流式事件；不在本轮接入全部第三方原生协议或多模态功能。
- Provider 指定默认协议，模型可覆盖。模型的可调用身份至少包含 Provider 配置身份与模型 ID；请求时进一步确定协议与参数。
- 用途默认值为 `analysis`、`chat`、`extraction`；操作时选择由 PRD F1 维护，配置快照、生成分支继承及缓存机制见[上下文管理器](ARCHITECTURE.md#41-上下文管理器servicescontextpy)与[LLM 层](ARCHITECTURE.md#42-llm-层llm)。
- 未来提取优先使用原生结构化输出，两种协议的结构化参数分别适配；提示词兼容方式仍执行相同业务校验并记录所用方式。未知能力不能视为支持，普通鉴权、网络等错误不能笼统触发协议／模型切换；模型发现与验证行为见 PRD F1。
- 参数按模型与协议支持情况处理，未指定时尽量省略；不统一强塞 temperature、推理强度或输出限制等字段。
- 所有生成请求经 LLM 层并形成 Run，包括用户触发的模型调用验证。密钥不写入普通配置响应、提示词、Run 或开发缓存；本地后端负责凭据的解析与使用。

对话、出处与执行状态由本地持久化管理，不依赖 Provider 远端会话保证权限或恢复。审核与保存核实见[架构 4.5](ARCHITECTURE.md#45-讨论与成果保存analysis已实现occurrence待设计)，预算、调度及停止机制见[架构 3.5](ARCHITECTURE.md#35-2c-analysis-与工具执行实现)和[4.6](ARCHITECTURE.md#46-job-与-workerjobs)。

协议参考：[模型列表](https://developers.openai.com/api/reference/resources/models)、[Chat Completions 与 Responses 的差异](https://developers.openai.com/api/docs/guides/migrate-to-responses)。这些说明用于界定官方协议；第三方兼容性须通过各自配置与验证确认。

阅读翻译复用既有文本 SDK、SQLite 和 asyncio，不增加依赖；独立任务及配置机制见[架构 4.8](ARCHITECTURE.md#48-阅读翻译与设备朗读)。设备朗读使用浏览器 Web Speech SpeechSynthesis，不能直接导出音频；设备声音可能来自本地或远端，不承诺离线可用。远端 TTS、专用翻译服务与端侧模型仍未选定。

## 4. 分发（分阶段）

1. **当前阶段：本地 Web 应用。** FastAPI 同时托管前端构建产物，`just start` 启动后在浏览器中打开 `http://127.0.0.1:<port>`。功能稳定之前一直停留在这个阶段。
2. **需要窗口外壳时：** 使用 pywebview 包一层，改动很小。
3. **正式分发时：** 使用 Tauri，将后端作为 sidecar（PyInstaller 打包；若届时后端已用其他语言重写，则直接集成）。

## 5. 仓库与工具

- 采用 monorepo：`backend/`、`frontend/`、`config/`、`docs/`。
- 使用 `justfile` 统一命令入口：`dev`、`start`、`test`、`lint`、`gen-api`、`migrate`。
- 使用 pre-commit 或提交前手动运行 `just lint`：强制执行 ruff、pyright、Biome 和 tsc 检查。

## 6. 明确不选的方案

| 方案 | 不选的原因 |
|---|---|
| Next.js | 本项目不需要 SSR 和服务端组件；这部分正是 agent 最容易出错的地方 |
| LangChain / LlamaIndex 等重型框架 | 抽象层厚、版本变化快；首轮讨论不依赖重型 Agent 框架，后续检索与写入工具协议再按需求设计 |
| SQLModel | 与 SQLAlchemy 2.0 的类型化写法混用时容易踩坑，训练语料也更少 |
| Celery / Redis | 单用户本地应用不需要 |
| UniDic / MeCab 系 | 体积大，更偏 NLP；分词采用 Sudachi |
| Electron | 体积大；Tauri 优先 |
