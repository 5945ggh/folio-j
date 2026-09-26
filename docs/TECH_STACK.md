# 技术选型

> 状态：草案 v0.3（2026-09-26）
> 选型原则：
> 1. 优先选择主流、AI 训练语料充分的方案（coding agent 友好）；
> 2. 前后端之间只有一份类型契约（OpenAPI）；
> 3. 零额外运维组件，不引入 Redis、独立数据库服务或消息队列；
> 4. 本地优先，但架构不排斥日后部署到服务器或打包为桌面应用。
>
> 版本策略：项目初始化时取各依赖的最新稳定版，由 lockfile（`uv.lock`、`pnpm-lock.yaml`）锁定；升级需显式进行。

当前工程锁文件为 `backend/uv.lock` 和 `frontend/pnpm-lock.yaml`。开发环境使用 Python 3.11、Node.js 24，Python 包最低支持 3.11；实际依赖以锁文件为准。选型不等于已经安装：当前只引入工程启动、类型生成、SQLite 迁移及检查所需依赖，LLM、规范化、分词与复杂 UI 组件依赖随对应切片添加。

基础运行补充依赖：Uvicorn 承载 ASGI 服务，httpx 通过本地 ASGI transport 测试 API，Hatchling 构建 Python 的 src 布局包。前端 TypeScript 暂锁 5.9.3，以满足所选 openapi-typescript 7.x 的 peer 范围；Node 类型锁在 24 系列，与运行时一致。Tailwind 使用官方 Vite 插件，不提前引入未使用的 shadcn 组件或 Zustand。

## 1. 后端（Python）

| 用途 | 选择 | 说明 |
|---|---|---|
| 语言 | Python ≥ 3.11 | 开发期使用 Python；稳定后可能用其他语言重写，因此业务逻辑应减少依赖 Python 特有的"魔法" |
| 环境与包管理 | uv | 所有命令都通过 `uv run` 执行 |
| Web 框架 | FastAPI | 自动生成 OpenAPI，作为前端类型的唯一来源 |
| 数据校验 | Pydantic v2 | 同时用于 API schema、LLM 结构化输出 schema 和配置模型 |
| ORM | SQLAlchemy 2.0（`Mapped` 类型化风格） | 不使用 SQLModel；ORM 模型与 API schema 分开定义 |
| 迁移 | Alembic | 发布前且数据可丢弃时可重整初始迁移，保证空库可重建；需保留日常数据或发布第一版后采用严格增量迁移；应用启动不自动删库 |
| 数据库 | SQLite（WAL 模式） | 单文件，备份即复制。检索：MVP 用 `LIKE`，P1 上 FTS5，远期用 sqlite-vec |
| SSE | sse-starlette | 用于 LLM 流式输出推送 |
| LLM 客户端 | `openai` 官方 Python SDK，通过 `base_url` 对接 | BYOK、多 Provider；适配 OpenAI 兼容的 Chat Completions 与 Responses 文本调用 |
| Prompt 模板 | Jinja2 | 模板以文件形式放在 `backend/prompts/`，文件头部标注版本号 |
| Markdown 解析 | markdown-it-py | 规范化器用它获取标题 token 及其行号映射 |
| 日语分词 | SudachiPy + SudachiDict-core，A 粒度切分 | 不使用 UniDic |
| 配置 | 应用运行配置使用 TOML + Pydantic；模型接入设置通过 UI 维护 | Provider／模型／用途默认值采用统一后端配置来源；持久化与凭据存储方案在架构中确定，不将 providers.toml 设为唯一入口 |
| ID | ULID（如 `python-ulid`） | 可排序，适合作为主键和 section uid |
| 后台任务 | SQLite `jobs` 表 + 进程内 asyncio worker | 不使用 Celery |
| 测试 | pytest、pytest-asyncio、hypothesis | 用 hypothesis 对规范化器做"可复原"的性质测试 |
| 静态检查 | ruff（lint + format）、pyright（strict） | |

## 2. 前端

| 用途 | 选择 | 说明 |
|---|---|---|
| 构建 | Vite | 纯 SPA；**不用 Next.js**：不需要 SSR，而且会增加打包与部署的复杂度 |
| 语言与框架 | TypeScript（strict）+ React | |
| 样式与组件 | Tailwind CSS + shadcn/ui | 组件源码复制进仓库，可自由修改 |
| 服务端状态 | TanStack Query | 所有 API 数据都经由它获取和缓存 |
| 本地 UI 状态 | Zustand（按需引入） | 能用组件 state 解决的就不引入 |
| 路由 | React Router（声明式 / library 模式）`[TBD-13]` | 不使用其 framework 模式 |
| API 客户端 | openapi-typescript + openapi-fetch | 由后端 OpenAPI 生成，**禁止手写接口类型** |
| Markdown 渲染 | react-markdown + remark-gfm | |
| Lint 与格式化 | Biome `[TBD-13]` | 单一工具，配置简单 |
| 单元测试 | Vitest（按需） | 前端逻辑较薄，测试以后端为主 |
| E2E | 暂不引入 | 由 coding agent 自带的浏览器能力做界面验证；以后需要再加 Playwright |
| 包管理 | pnpm | Node 使用当前 LTS 版本 |

## 3. 模型接入（BYOK）

产品行为见 [PRD 的 F1 设置](PRD.md)。技术接入区分 Provider、模型、调用协议及用途默认值，不将用途和协议混为一谈。

- 设置界面能够维护 Provider 名称、base_url、鉴权、默认协议、模型及三种用途默认值。界面与任何文件入口必须使用同一后端配置来源；具体持久化与凭据存储方式尚待架构确定。
- 首轮适配 OpenAI 兼容的 `chat_completions` 与 `responses` 两种文本协议。分别转换请求、解析响应与流式事件，不仅替换路径。不在本轮接入全部第三方原生协议或多模态功能；当前片段内读取与基本讲解／候选操作范围已确认，具体工具协议在架构中设计。
- Provider 指定默认协议，模型可覆盖。模型的可调用身份至少包含 Provider 配置身份与模型 ID；请求时进一步确定协议与参数。
- 模型发现通过 Provider 的列表接口尝试获取，同时允许手动添加模型 ID。保留缓存、刷新状态和最后更新时间。列表发现不作为流式、原生结构化输出或其他能力已经验证的依据。
- 能力判断应针对具体 Provider、模型及协议；列表获取、生成调用与输出能力分别反馈。未知能力不能直接视为支持，也不自动对所有模型执行生成测试。
- 提取优先使用原生结构化输出。Chat Completions 与 Responses 的结构化参数由各自适配器转换；兼容的提示词约束方式仍执行相同业务校验，并记录所用方式。普通鉴权、网络或其他错误不能笼统触发协议／模型切换。
- 用途默认值为 `analysis`、`chat`、`extraction`。按 PRD 解析片段预选、线程模型及单次选择；任务被接受后保存实际配置的非敏感快照，执行时不能重新用已变化的默认值解析。这些用途不规定固定调用顺序，也不要求每个条目调用模型；讨论中整理讲解、生成和修改候选的模型选择随入口契约确定，用户收录不需要模型调用。
- 参数按模型与协议支持情况处理，未指定时尽量省略；不统一强塞 temperature、推理强度或输出限制等字段。
- 对话与出处以本地保存为依据，适配器可处理协议差异，不将 Provider 远端会话 ID 作为唯一历史。各讨论线程历史独立，相关资料按需读取并保留出处；普通问答不自动保存讲解或收录条目。
- 工作台工具按 PRD F9 的线程权限执行。审核等待、用户决定和实际写入由本地应用管理，不能仅依赖提示词或 Provider 远端会话；Full access 只省去逐次审批，首轮仍不开放自动收录或整理状态工具。Agent 对条目的创建及内容修改限于待整理候选，用户界面负责整理决定。现有技术栈不变，工具协议与持久化契约在架构中细化。
- Agent 首轮读取限定当前 Segment 的资料、必要 Source 信息、本线程历史和用户背景／偏好，不跨片段或搜索其他线程聊天历史。初始默认审核模式，仅在线程空闲时切换；本地执行层管理同线程串行、审核等待与主动停止，不依赖 Provider 远端会话保证这些产品行为。
- 按 PRD F8 保留独立保存的成功结果，将逐项失败与实际保存情况反馈给 Agent。临时故障重试和 Agent 修复循环受协调后的有限执行预算约束，不能依靠各层自动重试叠加；次数、时间／调用上限与恢复契约在架构中确定，不新增独立队列或服务。
- 所有生成请求经 LLM 层并形成 Run，包括用户触发的模型调用验证。密钥不写入普通配置响应、提示词、Run 或开发缓存；本地后端负责凭据的解析与使用。

协议参考：[模型列表](https://developers.openai.com/api/reference/resources/models)、[Chat Completions 与 Responses 的差异](https://developers.openai.com/api/docs/guides/migrate-to-responses)。这些说明用于界定官方协议；第三方兼容性须通过各自配置与验证确认。

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
| UniDic / MeCab 系 | 体积大，更偏 NLP；已统一使用 Sudachi |
| Electron | 体积大；Tauri 优先 |
