# 阶段性交接

本目录保存当前实施基线和阶段指导；阶段任务完成或被新决策取代后移入 [archived/](archived/)。长期规范见 [文档导航](../README.md)，产品行为以 [PRD](../PRD.md) 为准。归档材料保存历史上下文，不能据此恢复过时的产品需求。

## 阶段资料

当前交付、提交状态与验收结论汇总见 [MVP 实施基线](MVP_IMPLEMENTATION_BASELINE.md)。以下按阶段职责组织实施安排、接口契约和原始证据。

- 文本处理与学习资料调整：架构解耦、人工保存与独立回看、统计和精确出处；见[实施计划](text-study/PLAN.md)、[验收样例](text-study/TEST_MATRIX.md)、[S0 收口](text-study/S0_ACCEPTANCE.md)、[B1 验收](text-study/B1_ACCEPTANCE.md)及[B2 验收](text-study/B2_ACCEPTANCE.md)。本批完成 S0 和 B 线，A／C 暂不实施。
- 书籍管理：详情页、共享信息编辑和卡片菜单，移动／删除保留禁用入口；见[计划与契约](book-management/PLAN.md)和[验收记录](book-management/ACCEPTANCE.md)。

- 全量注音：导入全书分词、持久派生资产、重建与两维注音显示；见[计划](full-ruby/PLAN.md)和[验收](full-ruby/ACCEPTANCE.md)。
- 设置顶部分类：学习偏好、模型与服务、对话与权限分组，统一弹窗、草稿保护与验证历史筛选；见[计划](settings-refresh/PLAN.md)和[验收](settings-refresh/ACCEPTANCE.md)。
- 章节位置记忆：每章位置持久化、目录恢复与章首返回，内容末端可读时 100% 与回看下降；见[工程与浏览器验收](epub-reading/CHAPTER_MEMORY_ACCEPTANCE.md)。
- 阅读器 R1.1：独立阅读空间、阅读偏好、原书 ruby、书内搜索／插图库及面板交互；见[计划](reader-r1/PLAN.md)、[API 契约](reader-r1/API.md)、[工程验收](reader-r1/ACCEPTANCE.md)和[交互优化](reader-r1/INTERACTION_POLISH.md)。
- 来源空间 S2：主导航／来源列表／来源内容三栏、四视图、有界概览与精确恢复；见[计划](sources-s2/PLAN.md)和[验收记录](sources-s2/ACCEPTANCE.md)。
- 素材库 A.1：轻原生素材库、整区空库导入和封面回退／缓存；见[计划](library-a1/PLAN.md)、[封面工程契约](library-a1/API.md)和[验收记录](library-a1/ACCEPTANCE.md)。
- 前端调整：目录、Source 三视图、使用状态与统一导航；见[计划](frontend-refresh/PLAN.md)、[API 契约](frontend-refresh/API.md)和[验收记录](frontend-refresh/ACCEPTANCE.md)。
- [EPUB 原生阅读阶段](epub-reading/README.md)：组织导入、基础阅读、注音、选区学习、材料对话和讲解形成的切片顺序与准备条件。

## Archived

- [开发期迁移基线整理验收](archived/DATABASE_BASELINE_ACCEPTANCE.md)：单初始基线、历史升级测试清理、业务回归与现用测试库数据保留证据。

- [阅读恢复、注音偏好与来源导航重构验收](archived/READER_STATE_REFACTOR_ACCEPTANCE.md)：集中三个生产协调入口，记录行为基线、独立审查、离线测试与浏览器验收。

- [编辑规则与讨论状态重构验收](archived/ARCHITECTURE_REFACTOR_ACCEPTANCE.md)：统一审核与保存、集中讨论推进、删除不可达 Job 代码；记录回归、CR 与离线浏览器验收。

- [2C 后阅读与导航打磨验收](archived/READING_NAVIGATION_ACCEPTANCE.md)：普通入口阅读、原文参照、精确导航及讲解总标题已通过离线验收；记录恢复修复、浏览器证据与限制。

- [第二阶段2C：Analysis与成果工具](archived/STAGE_2C_ANALYSIS_TOOLS.md)：生成并保存、确切修订读取、Section编辑／审核已完成离线验收；保留迁移、协议、浏览器及限制证据。

- [第二阶段 2B：片段后台异步问答](archived/STAGE_2B_ASYNC_QA.md)：已完成实现与离线验收；保留输入快照、原子锁定、持久历史、停止／重启、迁移及浏览器证据。

- [第二阶段 2A：设置与模型接入](archived/STAGE_2A_MODEL_SETTINGS.md)：已完成验收；保留接口、凭据、并发修复、迁移与浏览器证据。

- [第一阶段：素材与片段管理](archived/STAGE_1_SOURCE_SEGMENT.md)：已完成的首个领域切片，保留 API 契约、数据库策略与验收结果。
- [开发准备记录](archived/DEV_PREPARATION.md)：已完成的工程初始化、工具链与离线验证依据。
- [Occurrence 与 anchor 小样本试提取任务书](archived/ANCHOR_PILOT_AGENT_BRIEF.md)：实验任务记录；其 A0 规则和旧启动消息不是生产契约。

后续按选定切片更新相关规范，完成的阶段文档移入归档并保留结果与限制；不将执行记录复制到每份长期规范中。
