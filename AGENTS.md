# AGENTS.md

本文件写给在本仓库中工作的 coding agent。开始任何任务之前，请先阅读本文件。

## 项目是什么

一个 Agent 原生的日语学习辅助系统，当前处于 MVP 设计阶段。用户围绕 Source 下的 Segment 阅读与讨论，按需留下可独立阅读的讲解和 Occurrence；工作台是活动界面，不拥有学习内容。不要求先有完整解析才能讨论，也不强制所有内容经过独立 AI 提取阶段。讨论成果先整理为持久讲解，Occurrence 再关联原文与具体讲解版本。具体首轮入口、共享资料读取与成果写入契约以 PRD 中已确认和待定的边界为准，不按旧的线 A／线 B 流水线直接实现。

文档入口见 [`docs/README.md`](docs/README.md)。开发任务先读以下长期规范，并按当前阶段查阅 [`docs/handovers/README.md`](docs/handovers/README.md)：

- `docs/PRD.md`：做什么、不做什么、里程碑，以及待定事项（`[TBD-xx]`）
- `docs/GLOSSARY.md`：领域术语与已确认的身份、归属和引用边界
- `docs/ARCHITECTURE.md`：数据模型、模块规格、不变式、API 草图
- `docs/TECH_STACK.md`：技术选型，以及明确不选的方案

`docs/handovers/` 放阶段性实施指导；`archived/` 仅保存历史任务和实验上下文。产品行为以 PRD 为准，不能从旧 brief 恢复过时需求。当前工程初始化建议见 [`docs/handovers/DEV_PREPARATION.md`](docs/handovers/DEV_PREPARATION.md)，实施基线见 [`docs/handovers/MVP_IMPLEMENTATION_BASELINE.md`](docs/handovers/MVP_IMPLEMENTATION_BASELINE.md)；两者不替代长期规范或敲定 PRD 未决项。

## 常用命令

以下是目标命令入口；工程初始化前尚未建立 `justfile`，不能将命令缺失当作测试通过。

```bash
just dev        # 同时启动后端（热重载）和前端开发服务器
just start      # 构建前端，由 FastAPI 托管，本地运行
just test       # 后端 pytest（只回放 LLM 录制，不联网）
just lint       # ruff + pyright + biome + tsc
just gen-api    # 从后端 OpenAPI 重新生成前端客户端
just migrate    # alembic upgrade head
```

## 硬性规则

1. **路由层不写业务逻辑**，业务逻辑放在 `services/` 中。
2. **所有模型调用必须经过 `backend/src/app/llm/`**，每次调用都要产生一条 `Run` 记录。
3. **所有 prompt 以模板文件形式放在 `backend/prompts/`**，并在文件头部声明版本号。不要在 Python 代码中硬编码 prompt 文本；修改 prompt 时递增其版本号。
4. **规范化器是纯函数**，必须满足 R1 可复原、R2 幂等、R3 不改写（见 ARCHITECTURE 4.3），修改后必须通过性质测试。修改格式契约 prompt 时，同时检查规范化器；反之亦然。
5. **每次 ORM 模型变更都要附带 Alembic 迁移。**
6. **每次后端 schema 变更后都要运行 `just gen-api`**，并把生成的客户端一并提交。前端禁止手写接口类型。
7. **测试禁止访问真实网络或模型。** 需要新的 LLM 响应时，说明需要用 `RECORD=1` 录制，由人类执行。
8. **不要引入 TECH_STACK 中"明确不选"的依赖**；新增其他依赖时，在任务总结中说明理由。
9. **不要把密钥写入仓库。** `config/*.toml` 的真实文件已加入 gitignore，只维护 `*.example.toml`。
10. 修订（`AnalysisRevision`）一经生成就不可变；Occurrence 只做软删除（改变 `status`）。

## 编码约定

- **子代理模型**：调用 Codex 原生子代理时，显式指定 `gpt-6-sol` 或 `gpt-6-luna`。
- **PRD 版本**：审订期间不随每次编辑递增文档版本号，待最终收口时统一调整。
- **Python**：完整的类型注解，pyright 以 strict 模式通过；Pydantic v2；SQLAlchemy 2.0 的 `Mapped` 风格；全链路 async（数据库操作使用 aiosqlite）。
- **TypeScript**：strict 模式；服务端数据一律通过 TanStack Query 获取；UI 组件优先使用 shadcn/ui。
- **命名**：领域术语以 GLOSSARY 的已确认定义为准（Source、Segment、Run、Analysis、AnalysisRevision、Section、Occurrence……），架构草图须与之同步，不要自创同义词或将 Collection 当作 Source。
- **日语文本**：入库时做 NFC 规范化；比较 anchor 时使用 NFKC。字符偏移以 Python `str` 的码点为单位。

## 遇到 `[TBD-xx]` 时怎么办

按文档中的占位方案实现，并做到：

- 把占位决策集中在一处（常量、配置项或单独的函数），便于日后替换；
- 不要自行扩展占位方案之外的产品行为；
- 在任务总结中列出你触及了哪些 TBD。

## 完成的定义

- `just lint` 和 `just test` 全部通过；
- 新的纯逻辑有单元测试覆盖；
- 涉及 UI 的改动，用浏览器实际打开相关页面验证过，并在总结中描述看到了什么；
- 任务总结简要说明：做了什么、触及了哪些 TBD、有哪些已知限制。
