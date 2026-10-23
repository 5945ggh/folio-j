# 开发准备记录

> 状态：工程初始化完成，归档保存验证依据。产品行为以 [PRD](../../PRD.md)、[领域术语](../../GLOSSARY.md)、[架构](../../ARCHITECTURE.md) 为准；后续范围见 [实施基线](../MVP_IMPLEMENTATION_BASELINE.md)。

## 本轮范围

- 长期规范留在 `docs/`，阶段性指导移入 `docs/handovers/`；建立文档、研究材料与视觉原型索引。
- 保留可复核的语料、解析、提取结果、快照、验证脚本和阅读实验。原型是视觉参考，其历史模拟行为与当前 PRD 的差异已有说明。
- 建立 FastAPI + React/Vite 的本地工程基础、依赖锁文件、生成式 API 类型和统一 `just` 命令；没有提前实现 Source、Segment、Analysis 或 Occurrence 的领域表与业务功能。

## 已落地入口

- `GET /api/health` 经路由、服务与 Pydantic schema 返回健康状态；前端通过 TanStack Query 和生成类型的 openapi-fetch 读取，提供刷新／重试。
- `just dev` 同时运行本地 FastAPI 和 Vite；`just start` 构建前端并由 FastAPI 托管。未知 API 与缺失静态资源返回 404，页面导航可回退到 SPA。
- 本地 TOML 配置提供端口与数据库路径，默认无需配置；仅监听 `127.0.0.1`。样例可提交，真实配置、数据库、依赖缓存及本地快照被忽略。
- SQLAlchemy async + aiosqlite 开启 WAL 和外键约束；Alembic 可生成和执行迁移。主工程尚无领域模型，因此没有伪造初始业务迁移。
- `just gen-api` 从本地 FastAPI 导出 `backend/openapi.json` 并生成 `frontend/src/api/schema.d.ts`，不调用运行中的服务或模型。
- pytest 默认拦截真实 socket 连接及 DNS 解析；API 测试通过本地 ASGI transport，迁移在临时目录验证。

## 验证记录

| 验证 | 结果 |
|---|---|
| `just setup` | 锁定的后端与前端依赖可安装 |
| `just lint` | Ruff 检查／格式、pyright strict、Biome、TypeScript 均通过 |
| `just test` | 10 项离线后端测试通过，包含配置、API、SPA 边界、数据库、迁移生成升级与网络防护 |
| `just gen-api` | 离线生成成功，后端 schema 确定性导出 |
| `just migrate` | 初始化空迁移环境成功；未新增领域表 |
| `just build` | Vite 生产构建成功 |
| `just check-assets` | 原型 12 项状态测试、阅读解析器测试及 6 份样本／35 条记录的机械校验通过 |
| `just check-docs` | 维护中的规范、交接及资产索引本地链接有效 |
| 浏览器 | 开发地址 5173 与 FastAPI 托管地址 8000 均显示 Folio-J 开发环境和“已连接”；健康状态刷新正常 |

本机验证环境为 Python 3.14.7、Node.js 24.14.0、pnpm 10.34.5、uv 0.10.0、just 1.58.0。Python 最低版本声明为 3.11，但本轮未另外建立 3.11 测试矩阵；依赖精确版本以锁文件为准。没有进行真实模型效果测试，也不宣称工程壳已经具备产品功能。

## 下一步

按 [实施基线](../MVP_IMPLEMENTATION_BASELINE.md) 编排可独立体验的领域切片，连通界面、API、持久化与必要验证。优先实现素材与片段的真实管理，再依据选定切片明确规范化和工具执行契约；不从历史原型推断未定行为。讨论写入与恢复 `[TBD-16]`、组合审核呈现 `[TBD-17]` 等仍需在依赖它们的实现前细化。

日常启动与检查命令维护在[开发指南](../../DEVELOPMENT.md)，不以本归档记录替代最新说明。
