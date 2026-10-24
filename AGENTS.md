# AGENTS.md

本文件写给在本仓库中工作的 coding agent。开始任何任务之前，请先阅读本文件。

## 项目是什么

一个围绕日语原版内容的个人学习辅助系统，支持阅读、独立学习资料与按需讨论。当前交付状态、实现缺口与验收依据集中见 [MVP 实施基线](docs/handovers/MVP_IMPLEMENTATION_BASELINE.md)。

用户围绕 Source 下的 Material 阅读原文，围绕 Segment 保存和回看独立讲解，并按需要讨论；人工资料保存与 AI 生成共用内容保护规则，工作台不拥有学习内容。人工入口与材料出处按[文本与资料计划](docs/handovers/text-study/PLAN.md)实施，当前是否可用以实施基线为准。不要求先有完整解析才能讨论，也不强制经过独立 AI 提取阶段。后续 Occurrence 关联原文与具体讲解版本；具体入口、读取权限与成果写入以 PRD 为准。

文档入口见 [`docs/README.md`](docs/README.md)。开发任务先读以下长期规范，并按当前阶段查阅 [`docs/handovers/README.md`](docs/handovers/README.md)：

- `docs/PRD.md`：做什么、不做什么、里程碑，以及待定事项（`[TBD-xx]`）
- `docs/GLOSSARY.md`：领域术语与已确认的身份、归属和引用边界
- `docs/ARCHITECTURE.md`：数据模型、模块规格、不变式、API 草图
- `docs/TECH_STACK.md`：技术选型，以及明确不选的方案

`docs/handovers/` 放阶段性实施指导；`archived/` 仅保存历史任务和实验上下文。产品行为以 PRD 为准，不能从旧 brief 恢复过时需求。已完成的工程初始化记录见 [`docs/handovers/archived/DEV_PREPARATION.md`](docs/handovers/archived/DEV_PREPARATION.md)，实施基线见 [`docs/handovers/MVP_IMPLEMENTATION_BASELINE.md`](docs/handovers/MVP_IMPLEMENTATION_BASELINE.md)；两者不替代长期规范或敲定 PRD 未决项。

## 文档维护

维护项目文档时，先读项目级 skill [文档维护原则](.agents/skills/document-maintenance/SKILL.md)与[文档写作风格](.agents/skills/document-writing-style/SKILL.md)。前者规定信息归属与更新流程，后者规定直接、准确、简明的表达方式。

根 [README](README.md) 面向首次访问者，保留产品介绍、当前能力摘要和快速开始。[使用指南](docs/USAGE.md)维护日常操作与配置，[开发指南](docs/DEVELOPMENT.md)维护环境、命令与快照，[升级与备份](docs/UPGRADING.md)维护数据保护和旧库处理。修改这些内容时更新对应指南与入口链接；完整交付状态仍由实施基线维护。

## 常用命令

工程已建立 `justfile`，以下命令是实际开发入口；检查失败不能描述为验证通过。

```bash
just dev        # 同时启动后端（热重载）和前端开发服务器
just start      # 构建前端，由 FastAPI 托管，本地运行
just test       # 后端 pytest + 前端纯逻辑测试（禁用真实网络；未来 LLM 测试只回放录制）
just lint       # ruff + pyright + biome + tsc
just gen-api    # 从后端 OpenAPI 重新生成前端客户端
just migrate    # alembic upgrade head
just snapshot   # Repomix 在 .snapshots/ 生成带时间戳的 XML 仓库快照；别名 just snap
```

`just` 或 `just --list` 列出可用命令；环境与完整命令说明见[开发指南](docs/DEVELOPMENT.md)，快照工具依赖与输出说明见[仓库快照](docs/DEVELOPMENT.md#仓库快照)。使用已有数据库前先读[升级与备份](docs/UPGRADING.md)。

## 硬性规则

1. **路由层不写业务逻辑**，业务逻辑放在 `services/` 中。
2. **所有模型调用必须经过 `backend/src/app/llm/`**，每次调用都要产生一条 `Run` 记录。
3. **所有 prompt 以模板文件形式放在 `backend/prompts/`**，并在文件头部声明版本号。不要在 Python 代码中硬编码 prompt 文本；修改 prompt 时递增其版本号。
4. **规范化器是纯函数**，必须满足 R1 可复原、R2 幂等、R3 不改写（见 ARCHITECTURE 4.3），修改后必须通过性质测试。修改格式契约 prompt 时，同时检查规范化器；反之亦然。
5. **数据库 schema 必须可从空库重建。** 第一版发布前且数据可丢弃时，保留 Alembic 基础，允许重整初始迁移，不要求为每次开发中间状态维护升级路径。开始保存需保留的日常数据或发布第一版后，每次 ORM 变更必须附带增量迁移。启动应用不得自动删库。
6. **每次后端 schema 变更后都要运行 `just gen-api`**，并把生成的客户端一并提交。前端禁止手写接口类型。
7. **测试禁止访问真实网络或模型。** 需要新的 LLM 响应时，说明需要用 `RECORD=1` 录制，由人类执行。
8. **不要引入 TECH_STACK 中"明确不选"的依赖**；新增其他依赖时，在任务总结中说明理由。
9. **不要把密钥写入仓库。** `config/*.toml` 的真实文件已加入 gitignore，只维护 `*.example.toml`。
10. 修订（`AnalysisRevision`）一经生成就不可变；Occurrence 只做软删除（改变 `status`）。

## 编码约定

- **子代理模型与思考强度**：调用 Codex 原生子代理时，必须显式指定 `model="gpt-6.1-sol"` 和 `reasoning_effort`，思考强度从 `medium`、`high`、`xhigh` 中选择。显式指定该模型但省略思考强度时，实际使用模型默认的 `low` 思考强度。
- **PRD 版本**：审订期间不随每次编辑递增文档版本号，待最终收口时统一调整。
- **视觉参考**：`prototypes/reading-native` 提供风格与布局思路；具体交互按真实功能设计，不照搬模拟行为，产品边界以 PRD 为准。
- **分支与协作**：默认使用稳定 `main` 加短期 `codex/*` 功能分支，不额外维护长期 `develop`。主代理负责范围、契约、派遣和集成验收，开发与测试子代理分工；并行任务明确文件所有权，完成检查后再集成。
- **Python**：完整的类型注解，pyright 以 strict 模式通过；Pydantic v2；SQLAlchemy 2.0 的 `Mapped` 风格；全链路 async（数据库操作使用 aiosqlite）。
- **TypeScript**：strict 模式；服务端数据一律通过 TanStack Query 获取；UI 组件优先使用 shadcn/ui。
- **命名**：领域术语以 GLOSSARY 的已确认定义为准（Source、Segment、Run、Analysis、AnalysisRevision、Section、Occurrence……），架构草图须与之同步，不要自创同义词或将 Collection 当作 Source。
- **日语文本**：入库时做 NFC 规范化；比较 anchor 时使用 NFKC。字符偏移以 Python `str` 的码点为单位。

## 提交约定

- 提交标题、正文和说明使用中文；标题简洁说明变更目的，而不只罗列改了哪些文件。
- 遵循 Lore 协议，用有决策价值的 git trailers 记录约束、取舍、风险和验证。字段名沿用 `Constraint`、`Rejected`、`Confidence`、`Scope-risk`、`Directive`、`Tested`、`Not-tested`；标准枚举值保持协议原样，其余描述使用中文。
- 按可独立审阅和回退的逻辑目标提交；同一目标的实现、测试和配套文档一起收口，独立修复或决策单独保留。不将尚未验证的内容描述成已完成。
- 合入前归并未推送的临时提交、重复修补和状态同步；先备份历史与未提交内容，保留重要决策和验证限制。已推送历史不为减少提交数或改写文案而重写。
- 一个短期 `codex/*` 分支只承载一个独立目标，从最新 `main` 开始；验收完成后及时合入，新目标另开分支，避免沿已完成分支持续串接。
- 合入并推送后，确认提交或等价改动已进入 `main`，清理对应的本地和远端功能分支；删除前检查未提交改动和其他 worktree 的使用情况。

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
