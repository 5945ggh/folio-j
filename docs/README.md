# 文档导航

开发前先读仓库根目录的 [AGENTS.md](../AGENTS.md)。长期规范保留在本目录，阶段方案与执行记录放在 `handovers/`；下表按需要确认的问题导航。

| 想确认的问题 | 负责文档 | 维护边界 |
|---|---|---|
| 为什么做、长期怎样演进 | [PRODUCT_DIRECTION.md](PRODUCT_DIRECTION.md) | 动机、取舍与待验证设想；方向不自动成为实施要求 |
| 文本处理与学习资料如何解耦 | [文本与资料实施计划](handovers/text-study/PLAN.md) | 文本接口、人工讲解、独立回看、统计与精确出处的切片和依赖；S0、B 线之后推进 A 线 |
| EPUB 阅读与学习衔接如何继续推进 | [EPUB 原生阅读阶段](handovers/epub-reading/README.md) | 切片顺序、准备条件，以及注音、选区学习、材料对话和讲解形成的边界 |
| 初次前端调整做过什么 | [前端调整](handovers/frontend-refresh/PLAN.md) | 目录、Source 三视图、使用状态与统一导航的实施范围和历史证据 |
| 素材库 A.1 如何实施与回归 | [素材库 A.1 计划](handovers/library-a1/PLAN.md) | 空库导入、工具与书卡、封面回退及缓存的实施与回归安排 |
| 书籍详情与信息编辑如何实施 | [书籍管理契约](handovers/book-management/PLAN.md) | 书籍菜单、详情、书名与封面原子编辑，以及移动／删除禁用边界 |
| 来源空间 S2 如何实施与回归 | [S2 计划](handovers/sources-s2/PLAN.md) | 三栏／四视图、有界概览与精确恢复的实施范围和验收入口 |
| 独立阅读器有哪些能力与验证边界 | [R1.1 计划](handovers/reader-r1/PLAN.md)、[交互优化](handovers/reader-r1/INTERACTION_POLISH.md) | 阅读偏好、原书 ruby、搜索、插图库及面板交互的契约和验证边界 |
| 全量注音如何生成、重建与展示 | [实施计划](handovers/full-ruby/PLAN.md)、[工程验收](handovers/full-ruby/ACCEPTANCE.md) | 导入等待、持久分词代次、原书注音优先、两维设置及实际验证 |
| 首轮承诺什么行为、哪些决定未定 | [PRD.md](PRD.md) | 范围、用户行为、验收与 `[TBD-xx]`；P0 不表示已经交付 |
| 名词指什么、身份与引用如何区分 | [GLOSSARY.md](GLOSSARY.md) | 定义、不变式、词表和反例；完整操作流程引用 PRD |
| 系统如何保证已确认行为 | [ARCHITECTURE.md](ARCHITECTURE.md) | 模型、执行校验、事务与恢复机制；未来草图明确标识 |
| 当前内容如何找到、打开、参照与返回 | [INFORMATION_ARCHITECTURE.md](INFORMATION_ARCHITECTURE.md) | 页面职责、导航、URL 定位与临时 UI 状态 |
| 选了哪些技术、为什么 | [TECH_STACK.md](TECH_STACK.md) | 选型、采用状态、分发及明确不选的方案；执行细节引用架构 |
| 已做到哪里、首轮还缺什么 | [MVP 实施基线](handovers/MVP_IMPLEMENTATION_BASELINE.md) | 当前交付与提交状态、实现差额、未落实契约与验收入口 |
| 当时做过什么、证据和限制是什么 | [阶段资料与归档](handovers/README.md)、[研究材料](../references/README.md) | 历史任务与实验依据，不覆盖现行规范 |

产品决定由 PRD 维护，当前交付状态由实施基线维护，阶段资料与历史证据从 [handovers/](handovers/README.md)查找。文档维护流程与写作规则见 [AGENTS 的文档维护入口](../AGENTS.md#文档维护)。
