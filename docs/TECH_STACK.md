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
| 迁移 | Alembic | 单一固定 DDL 基线 `0001_schema_baseline` 从空库直接建立当前 28 表，不依赖运行时 ORM；全程启用外键、显式写事务及提交前校验。保留 `just migrate` 与后续增量迁移基础，应用启动不自动删库或 stamp；边界见[架构](ARCHITECTURE.md#3-领域模型) |
| 数据库 | SQLite（WAL 模式） | 已采用；积累库检索尚未实现，选型保留 MVP 用 `LIKE`、P1 用 FTS5、远期用 sqlite-vec。运行中的 WAL 数据库备份须保证一致性，不能仅复制主文件 |
| SSE | sse-starlette（预留，未安装） | 当前页面轮询持久 Run／Job；模型侧流式响应不等于浏览器已采用 SSE |
| LLM 客户端 | `openai` 官方 Python SDK，通过 `base_url` 对接 | BYOK、多 Provider；适配 OpenAI 兼容的 Chat Completions 与 Responses 文本调用 |
| Prompt 模板 | Jinja2 | 模板以文件形式放在 `backend/prompts/`，文件头部标注版本号 |
| Markdown 解析 | markdown-it-py | 规范化器用它获取标题 token 及其行号映射 |
| 日语分词 | SudachiPy + SudachiDict-core，A 粒度切分 | 已采用；新书导入完整生成后可读，旧书可补算，结果独立版本化；不使用 UniDic |
| 配置 | 应用运行配置使用 TOML + Pydantic；模型接入设置通过 UI 维护 | 已采用；Provider／模型／用途默认值保存在 SQLite，凭据保存在数据库旁私有目录，不将 providers.toml 设为唯一入口 |
| ID | ULID（当前由 `app/ids.py` 实现） | 已用于主键和 Section uid；未安装 `python-ulid` |
| 后台任务 | SQLite `chat_jobs` 表（领域 Job）+ 进程内 asyncio worker | 问答与讲解共用执行机制；模型调用记录存于 `runs` |
| 测试 | pytest、pytest-asyncio、hypothesis | 用 hypothesis 对规范化器做"可复原"的性质测试 |
| 静态检查 | ruff（lint + format）、pyright（strict） | |

分词采用固定材料正文之上的可重建派生数据，输入版本、分析器、词典和配置与结果一起记录；不改写定位正文，不用 token 身份替代原文位置。生成使用本地词典，不调用模型；结果以 SQLite 中的压缩 JSON 保存，复用已有标准库能力。具体边界见[架构](ARCHITECTURE.md)。此处的数据 sidecar 与分发阶段的后端 sidecar 进程是不同含义。

EPUB 编译使用标准库 ZIP／XML／HTML 处理与已有 Pydantic 定义编译产物；包内资源清洗和有界编译不引入阅读器引擎或新依赖。不可变原 EPUB 与压缩编译包保存为 SQLite BLOB，材料发布和副本保存共用事务；接受数据库体积增长，避免外置文件的双提交及无主文件清理。阅读使用按章节排列的无脚本 sandbox iframe，隔离各原始资源的作者样式。模型、版本与阅读恢复边界见[架构](ARCHITECTURE.md)。

编译包统一通过标准库 zlib 与共享图片字符串池无损编码，消除完整资源 HTML 和章节片段间的图片重复；无图使用空池，单次压缩，不保留旧格式读取、回退或专用转换工具。不增加依赖、外置文件或资源服务，完整逻辑产物及前端 data URI 保持不变。编译器复用一次有界归档读取的类型化结果。物理格式、两级解码预算与开发库边界集中见[架构](ARCHITECTURE.md#31-实体)。

独立删除材料在同一事务内清空其原书／编译 BLOB 并删除派生阅读数据，保留身份与学习积累；释放的 SQLite 空页供后续复用，每次删除不做全库压缩。用户原始 EPUB 文件不受影响，具体清理与空间边界见[架构](ARCHITECTURE.md#31-实体)。

封面缓存只支持有界静态 PNG／JPEG（4 MiB、1600 万像素），使用标准库校验头部与结构，不引入图像解码库；APNG、GIF、WebP、SVG 与异常文件占位。优先提取有效声明封面，不可用时按有序包内图片候选回退，旧书可按规则版本重建缓存；不改不可变书籍产物，不下载远程图片。SVG `image` 只可作为包内静态图片引用来源，不表示支持 SVG 封面。正文图库沿用编译包的图片安全预算，不直接套用封面的 4 MiB／PNG-JPEG 限制。

搜索与图库使用服务层只读派生接口，不增加数据库索引实体；扫描与解压离开事件循环，响应有界分页，图片由受控 content endpoint 按需加载。具体实现见[架构](ARCHITECTURE.md)。

## 2. 前端

文本分析与书籍统计沿用 Sudachi、Pydantic、SQLite、asyncio 和前端 SVG 能力。文本分析接口不依赖 EPUB 呈现；统计采用后端纯计算、有界进程内缓存与独立并发限制，重启后按需重算，不新增 token 数据表、统计数据库、聊天任务或外部队列。交付状态见[实施基线](handovers/MVP_IMPLEMENTATION_BASELINE.md)。

| 用途 | 选择 | 说明 |
|---|---|---|
| 构建 | Vite | 纯 SPA；**不用 Next.js**：不需要 SSR，而且会增加打包与部署的复杂度 |
| 语言与框架 | TypeScript（strict）+ React | |
| 样式与组件 | Tailwind CSS 已采用；shadcn/ui 预留 | 当前无已引入的 shadcn 组件；选用时将组件源码复制进仓库 |
| 服务端状态 | TanStack Query | 所有 API 数据都经由它获取和缓存 |
| 本地 UI 状态 | React 组件 state；Zustand 预留，未安装 | 能用组件 state 解决的就不引入 |
| 路由 | React Router（library 的 Data router）`[TBD-13]` | RouterProvider 承载现有组件路由，供设置草稿使用 useBlocker；不使用 framework 模式，服务端数据仍由 TanStack Query 管理 |
| API 客户端 | openapi-typescript + openapi-fetch | 由后端 OpenAPI 生成，**禁止手写接口类型** |
| Markdown 渲染 | react-markdown + remark-gfm | |
| Lint 与格式化 | Biome `[TBD-13]` | 单一工具，配置简单 |
| 单元测试 | Node.js 内置测试；Vitest 按需 | 当前用 Node.js 24 直接运行 TypeScript 纯逻辑测试，不引入前端测试依赖；组件测试框架按需添加 |
| E2E | 暂不引入 | 由 coding agent 自带的浏览器能力做界面验证；以后需要再加 Playwright |
| 包管理 | pnpm | Node 使用当前 LTS 版本 |

Reader 继续使用无脚本、同源隔离 iframe，保留 CSP／sandbox；工具事件由父应用适配。搜索高亮采用 DOM Range／CSS Highlight，不改正文定位叶子；图库与大图使用非模态局部面板，保留正文交互、Escape 层级和关闭焦点恢复。展示层轻量动画支持减少动态效果偏好，不改变正文布局与位置保存。主题与阅读偏好在 Reader 作用域及浏览器 Storage 内校验，失败退回内存；浏览器及扩展兼容性的实际验证范围见[实施基线](handovers/MVP_IMPLEMENTATION_BASELINE.md)。

## 3. 模型接入（BYOK）

产品设置行为见[PRD F1](PRD.md#f1-设置)，权限与反馈见[F9](PRD.md#f9-agent-工具权限与审核)、[F8](PRD.md#f8-状态与诊断)。技术接入区分 Provider、模型、调用协议及用途默认值，不将用途和协议混为一谈。

当前已实现两种协议的普通／流式文本与 Analysis 原生工具调用、讲解生成分支、本地审核和有界执行。以下涉及 Occurrence 候选、结构化提取及复杂组合恢复的条目仍是目标约束，尚无对应生产实现；已落实的 Analysis 执行契约见 [ARCHITECTURE](ARCHITECTURE.md)。

- 设置界面维护 Provider 名称、base_url、鉴权、默认协议、模型及三种用途默认值。2A 的统一配置来源为 SQLite；凭据保存为数据库旁私有目录中的独立文件，数据库只保存内部引用。密钥更新产生新引用，不改变已接受验证的配置快照；具体见架构与阶段契约。
- 首轮适配 OpenAI 兼容的 `chat_completions` 与 `responses` 两种文本协议。分别转换请求、解析响应与流式事件，不仅替换路径。不在本轮接入全部第三方原生协议或多模态功能；当前片段内的 Analysis 读取、生成与编辑协议已实现，候选操作协议仍待设计。
- Provider 指定默认协议，模型可覆盖。模型的可调用身份至少包含 Provider 配置身份与模型 ID；请求时进一步确定协议与参数。
- 模型发现通过 Provider 的列表接口尝试获取，同时允许手动添加模型 ID。保留缓存、刷新状态和最后更新时间。列表发现不作为流式、原生结构化输出或其他能力已经验证的依据。
- 能力判断应针对具体 Provider、模型及协议；列表获取、生成调用与输出能力分别反馈。未知能力不能直接视为支持，也不自动对所有模型执行生成测试。
- 提取优先使用原生结构化输出。Chat Completions 与 Responses 的结构化参数由各自适配器转换；兼容的提示词约束方式仍执行相同业务校验，并记录所用方式。普通鉴权、网络或其他错误不能笼统触发协议／模型切换。
- 用途默认值为 `analysis`、`chat`、`extraction`。按 PRD 解析片段预选、线程模型及单次选择；任务被接受后保存实际配置的非敏感快照，执行时不能重新用已变化的默认值解析。用途不规定固定调用顺序。生成分支的配置继承与缓存理由集中在[架构4.1](ARCHITECTURE.md#41-上下文管理器servicescontextpy)；候选入口的模型契约仍待设计。
- 参数按模型与协议支持情况处理，未指定时尽量省略；不统一强塞 temperature、推理强度或输出限制等字段。
- 对话与出处以本地保存为依据，适配器可处理协议差异，不将 Provider 远端会话 ID 作为唯一历史。线程历史隔离与资料归属由本地持久化和执行层校验，具体范围见[PRD 4.5](PRD.md#45-讨论共享资料与成果保存)。
- 审核等待、用户决定、实际写入及同线程串行由本地应用维护，不依赖提示词或Provider远端会话保证权限、停止与恢复。Analysis工具与持久化已实现；候选工具及复杂组合恢复仍待设计，范围由[PRD F9](PRD.md#f9-agent-工具权限与审核)维护，具体方案／版本校验见[架构4.5](ARCHITECTURE.md#45-讨论与成果保存analysis已实现occurrence待设计)。
- 已保存成果、Run与Job终态分开记录，写入不确定先核实本地事实；重试与Agent修复共享有限预算，防止各层重试叠加。预算及恢复机制见[架构3.5](ARCHITECTURE.md#35-2c-analysis-与工具执行实现)和[4.6](ARCHITECTURE.md#46-job-与-workerjobs)，不新增独立队列或服务。
- 所有生成请求经 LLM 层并形成 Run，包括用户触发的模型调用验证。密钥不写入普通配置响应、提示词、Run 或开发缓存；本地后端负责凭据的解析与使用。

协议参考：[模型列表](https://developers.openai.com/api/reference/resources/models)、[Chat Completions 与 Responses 的差异](https://developers.openai.com/api/docs/guides/migrate-to-responses)。这些说明用于界定官方协议；第三方兼容性须通过各自配置与验证确认。

阅读翻译复用既有文本 SDK、SQLite 和 asyncio，不增加依赖。独立翻译任务与当前 chat_jobs 分开；设置与 Provider 保留既有身份，迁移及事务见[架构 4.8](ARCHITECTURE.md#48-阅读翻译与设备朗读)。设备朗读使用浏览器 Web Speech SpeechSynthesis，支持播放控制及声音检测，不能直接导出音频；设备声音可能来自本地或远端，不承诺离线可用。远端 TTS、专用翻译服务与端侧模型仍未选定。候选资源限制由应用配置集中维护，真实模型质量与设备声线需要独立实测。

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
