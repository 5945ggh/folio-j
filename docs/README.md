# 文档导航

开发前先读仓库根目录的 [AGENTS.md](../AGENTS.md)。长期规范保留在本目录，阶段方案与执行记录放在 `handovers/`；下表按需要确认的问题导航。

| 想确认的问题 | 负责文档 | 维护边界 |
|---|---|---|
| 为什么做、长期怎样演进 | [PRODUCT_DIRECTION.md](PRODUCT_DIRECTION.md) | 动机、取舍与待验证设想；方向不自动成为实施要求 |
| 下一阶段如何接入原生阅读与已有学习能力 | [EPUB 原生阅读阶段](handovers/epub-reading/README.md) | 汇集方向、材料定位基线、分词后补边界、准备条件与开发切片；不是另一套长期规范 |
| 首轮承诺什么行为、哪些决定未定 | [PRD.md](PRD.md) | 范围、用户行为、验收与 `[TBD-xx]`；P0 不表示已经交付 |
| 名词指什么、身份与引用如何区分 | [GLOSSARY.md](GLOSSARY.md) | 定义、不变式、词表和反例；完整操作流程引用 PRD |
| 系统如何保证已确认行为 | [ARCHITECTURE.md](ARCHITECTURE.md) | 模型、执行校验、事务与恢复机制；未来草图明确标识 |
| 当前内容如何找到、打开、参照与返回 | [INFORMATION_ARCHITECTURE.md](INFORMATION_ARCHITECTURE.md) | 页面职责、导航、URL 定位与临时 UI 状态 |
| 选了哪些技术、为什么 | [TECH_STACK.md](TECH_STACK.md) | 选型、采用状态、分发及明确不选的方案；执行细节引用架构 |
| 已做到哪里、首轮还缺什么 | [MVP 实施基线](handovers/MVP_IMPLEMENTATION_BASELINE.md) | 实现差额、未落实契约与验收入口，不维护第二份产品规格 |
| 当时做过什么、证据和限制是什么 | [归档交接](handovers/README.md)、[研究材料](../references/README.md) | 历史任务与实验依据，不覆盖现行规范 |

完整规则在负责文档中维护，其他位置保留理解本层所需的短边界并链接过去。例如，术语表解释旧引用的身份，PRD 说明用户行为，架构说明如何校验；审核分类与反馈流程集中见 [PRD F9](PRD.md#f9-agent-工具权限与审核)。修改规则时同步受影响的实现与引用，不在多个文档重复整套流程。

**已确认与已实现分别判断。** 当前实现进度、缺口和验收依据集中见 [MVP 实施基线](handovers/MVP_IMPLEMENTATION_BASELINE.md)；归档验收是对应阶段的历史证据，不等于每次文档更新都重新验证。代码和生成的 OpenAPI 用于核对实际行为，PRD 用于确定目标行为；二者有差异时，先辨别实现缺口、文档过时或待讨论的决定。

[handovers/](handovers/README.md) 保存当前阶段的实施指导和已归档任务书。阶段文档帮助安排工作，不能覆盖 PRD 中已确认的行为，也不能把旧任务书、实验结果或架构占位恢复成新需求。遇到未决行为，先查看 PRD 对应的 `[TBD-xx]` 与当前占位方案，再在依赖该决定的切片中细化。
