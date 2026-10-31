# 文档导航

首次了解项目见[项目首页](../README.md)。本目录包含使用与开发指南、长期规范；阶段方案与执行记录放在 `handovers/`。下表按需要确认的问题导航，参与开发前先读仓库根目录的 [AGENTS.md](../AGENTS.md)。

| 想确认的问题 | 负责文档 | 维护边界 |
|---|---|---|
| 如何阅读、设置模型和保存讲解 | [使用指南](USAGE.md) | 日常操作、模型调用与费用、应用配置 |
| 如何准备开发环境、执行检查和生成快照 | [开发指南](DEVELOPMENT.md) | 依赖版本、开发命令、API 生成与快照工具 |
| 如何保留数据、升级和恢复旧库 | [升级与备份](UPGRADING.md) | 数据与凭据备份、迁移入口、旧开发库处理边界 |
| 为什么做、长期怎样演进 | [PRODUCT_DIRECTION.md](PRODUCT_DIRECTION.md) | 动机、取舍与待验证设想；方向不自动成为实施要求 |
| 文本处理与学习资料如何解耦 | [文本分析与统计契约](ARCHITECTURE.md#314-文本分析与统计契约)、[文本与资料历史计划](handovers/archived/text-study/PLAN.md) | 现行契约由架构与 PRD 维护；历史计划保留切片依赖、实施依据与验收入口，当前交付状态见实施基线 |
| 怎样按词性、词频、词形或读音查看一本书的词汇并返回原文 | [材料词汇页](INFORMATION_ARCHITECTURE.md#材料词汇页)、[使用指南](USAGE.md#查看统计与材料词汇) | 页面、筛选与返回规则由阅读与导航维护，频次与身份口径见 PRD／架构，验证范围见[本轮验收](handovers/reading-practice/VOCABULARY_ACCEPTANCE.md) |
| EPUB 阅读与学习衔接如何继续推进 | [EPUB 原生阅读阶段](handovers/epub-reading/README.md) | 切片顺序、准备条件，以及注音、选区学习、材料对话和讲解形成的边界 |
| 实际阅读中发现的复制、书签与搜索需求怎样落地 | [实际阅读评测计划](handovers/reading-practice/PLAN.md) | 已确认用途、三阶段实施顺序与各阶段验收重点 |
| 阅读设置如何分组，作用域与保存方式如何表达 | [阅读设置交互](INFORMATION_ARCHITECTURE.md#阅读设置分组与会话)、[结构调查与实施进展](handovers/reading-practice/READER_SETTINGS_STRUCTURE.md) | 现行分组、保存范围与会话规则由阅读与导航维护；结构资料保留调查基准和低保真记录，生产验收状态见实施基线 |
| 目录、书籍管理、阅读器和注音有哪些现行契约 | [架构](ARCHITECTURE.md#31-实体)、[阅读与导航](INFORMATION_ARCHITECTURE.md) | 服务接口、缓存与发布机制、页面操作及状态恢复；验收限制从实施基线查找 |
| 首轮承诺什么行为、哪些决定未定 | [PRD.md](PRD.md) | 范围、产品行为、内容保护、验收与 `[TBD-xx]`；决定依据链接原始方案和验收，P0 不表示已经交付 |
| 名词指什么、身份与引用如何区分 | [GLOSSARY.md](GLOSSARY.md) | 定义、不变式、词表和反例；完整操作流程引用 PRD |
| 系统如何保证已确认行为 | [ARCHITECTURE.md](ARCHITECTURE.md) | 模型、执行校验、事务与恢复机制；未来草图明确标识 |
| 视觉基线、应用主题与阅读配色如何维护 | [设计系统](DESIGN_SYSTEM.md) | 现有视觉、颜色作用域与语义变量使用规则；实际色值由代码维护 |
| 当前内容如何找到、打开、参照与返回，界面怎样操作和呈现 | [INFORMATION_ARCHITECTURE.md](INFORMATION_ARCHITECTURE.md) | 页面职责、路由、焦点与快捷键、临时 UI 状态及具体表现参数 |
| 选了哪些技术、为什么 | [TECH_STACK.md](TECH_STACK.md) | 选型、采用状态、分发及明确不选的方案；执行细节引用架构 |
| 已做到哪里、首轮还缺什么 | [MVP 实施基线](handovers/MVP_IMPLEMENTATION_BASELINE.md) | 当前交付与提交状态、实现差额、未落实契约与验收入口 |
| 当时做过什么、证据和限制是什么 | [阶段归档](handovers/README.md#archived)、[研究材料](../references/README.md) | 已完成阶段的计划、接口快照与原始验收；实验依据不覆盖现行规范 |

产品决定由 PRD 维护，当前交付状态由实施基线维护，阶段资料与历史证据从 [handovers/](handovers/README.md)查找。文档维护流程与写作规则见 [AGENTS 的文档维护入口](../AGENTS.md#文档维护)。
