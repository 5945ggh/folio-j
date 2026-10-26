# 阶段性交接

本目录保存当前实施基线和阶段指导；阶段任务完成或被新决策取代后移入 [archived/](archived/)。长期规范见 [文档导航](../README.md)，产品行为以 [PRD](../PRD.md) 为准。归档材料保存历史上下文，不能据此恢复过时的产品需求。

## 阶段资料

当前交付、提交状态与验收结论汇总见 [MVP 实施基线](MVP_IMPLEMENTATION_BASELINE.md)。本节保留未完成阶段的安排与配套验收；目录、封面、书籍编辑及阅读器的现行接口由[架构](../ARCHITECTURE.md)维护。

- EPUB 编译包空间优化：[图片去重、章节 HTML 单格式与验收](EPUB_STORAGE_ACCEPTANCE.md)，当前开发库边界见[升级与备份](../UPGRADING.md#epub-存储格式与开发库重建)。
- 数据库迁移整理：[完整初始基线验收](DATABASE_MIGRATION_ACCEPTANCE.md)，当前迁移入口与旧库边界见[升级与备份](../UPGRADING.md#当前迁移基线)。

- 文本处理与学习资料调整：架构解耦、人工保存与独立回看、统计和精确出处；见[实施计划](text-study/PLAN.md)、[验收样例](text-study/TEST_MATRIX.md)、[S0 收口](text-study/S0_ACCEPTANCE.md)、[B1 验收](text-study/B1_ACCEPTANCE.md)及[B2 验收](text-study/B2_ACCEPTANCE.md)。A 线证据见[独立回看](text-study/A1_ACCEPTANCE.md)与[人工资料](text-study/A2_ACCEPTANCE.md)，C 线见[C1](text-study/C1_ACCEPTANCE.md)、[C2](text-study/C2_ACCEPTANCE.md)、[阅读体验](text-study/READING_EXPERIENCE_ACCEPTANCE.md)、[保存表单](text-study/SEGMENT_SAVE_FORM_ACCEPTANCE.md)与[原处预览](text-study/INLINE_PREVIEW_ACCEPTANCE.md)验收；当前状态汇总至实施基线。
- [阅读翻译、译文留存与设备朗读方案](text-study/TRANSLATION_AND_SPEECH_PLAN.md)：2026-10-23 已确认行为并授权实施，覆盖成功译文找回、转为 Segment、Provider 与设置调整；资源上限保留为待实测候选，[验收与限制](text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md)记录离线及浏览器证据，交付状态见实施基线。
- [EPUB 原生阅读阶段](epub-reading/README.md)：组织导入、基础阅读、注音、选区学习、材料对话和讲解形成的切片顺序与准备条件。
- [材料独立删除验收](MATERIAL_DELETION_ACCEPTANCE.md)：只删材料、保留来源与学习积累的增量迁移、工程检查、独立审查和隔离浏览器验证。
- [EPUB 导入书卡反馈验收](EPUB_IMPORT_FEEDBACK_ACCEPTANCE.md)：提交立即关闭弹窗、共享准备状态、失败重试和删除竞态保护。
- [阅读会话保留与加载测量](text-study/READER_SESSION_ACCEPTANCE.md)：最近一本书的短期保留、恢复核验、学习状态刷新、历史基线比较及验证范围。

- [本轮 CR 修复验收](CR_FIXES_ACCEPTANCE.md)：EPUB 资源预算与编译性能、聊天运行正确性、历史查询与渲染回归。

## Archived

2026-10-20 将以下已完成阶段移入归档，保留当时的计划、接口快照、验收数字、用户反馈与未验证项。书籍管理、S2 的用户使用验收待项继续由[实施基线](MVP_IMPLEMENTATION_BASELINE.md)维护。归档接口中的旧默认值、旧迁移编号和当时的能力限制仅用于理解历史。

2026-10-24 整理本机临时资产：文档链接引用的证据迁至私有目录，验收库、旧构建、脚本及其余临时产物已清理。历史 `temp/` 路径和启动命令记录当时环境，不能作为现成可用的复现入口；保留清单与范围见[本机证据保留说明](archived/LOCAL_EVIDENCE.md)。

| 阶段 | 计划与接口快照 | 验收证据 |
| --- | --- | --- |
| 片段专注布局 | [范围](archived/segment-layout/PLAN.md) | [工程、浏览器及用户反馈](archived/segment-layout/ACCEPTANCE.md) |
| 书籍管理 | [计划与接口](archived/book-management/PLAN.md) | [工程与浏览器验收](archived/book-management/ACCEPTANCE.md) |
| 全量注音 | [计划](archived/full-ruby/PLAN.md) | [生成、恢复与提交复核](archived/full-ruby/ACCEPTANCE.md) |
| 设置顶部分类 | [计划](archived/settings-refresh/PLAN.md) | [分组保存、草稿与验证历史](archived/settings-refresh/ACCEPTANCE.md) |
| 阅读器 R1.1 | [计划](archived/reader-r1/PLAN.md)、[API 快照](archived/reader-r1/API.md) | [工程验收](archived/reader-r1/ACCEPTANCE.md)、[后续交互优化](archived/reader-r1/INTERACTION_POLISH.md) |
| 来源空间 S2 | [计划](archived/sources-s2/PLAN.md) | [工程与浏览器验收](archived/sources-s2/ACCEPTANCE.md) |
| 素材库 A.1 | [计划](archived/library-a1/PLAN.md)、[封面 API 快照](archived/library-a1/API.md) | [素材库与后续导入表单](archived/library-a1/ACCEPTANCE.md) |
| 前端调整 | [计划](archived/frontend-refresh/PLAN.md)、[API 快照](archived/frontend-refresh/API.md)、[未定案备忘](archived/frontend-refresh/FUTURE_NOTES.md) | [目录、状态与导航](archived/frontend-refresh/ACCEPTANCE.md) |
| EPUB 基础阅读 | [章节与阅读调查](archived/epub-reading/CHAPTER_RESEARCH.md) | [切片 0](archived/epub-reading/SLICE_0_ACCEPTANCE.md)、[切片 1](archived/epub-reading/SLICE_1_ACCEPTANCE.md)、[章节位置记忆与章末进度](archived/epub-reading/CHAPTER_MEMORY_ACCEPTANCE.md) |

- [开发期迁移基线整理验收](archived/DATABASE_BASELINE_ACCEPTANCE.md)：单初始基线、历史升级测试清理、业务回归与现用测试库数据保留证据。

- [阅读恢复、注音偏好与来源导航重构验收](archived/READER_STATE_REFACTOR_ACCEPTANCE.md)：集中三个生产协调入口，记录行为基线、独立审查、离线测试与浏览器验收。
- [阅读跳转深化验收](archived/READER_NAVIGATION_REFACTOR_ACCEPTANCE.md)：集中导航意图、原点与相邻锁，记录表征、interface 回归、独立审查及隔离浏览器验证；提交状态见实施基线。
- [翻译会话深化验收](archived/TRANSLATION_SESSION_REFACTOR_ACCEPTANCE.md)：记录双入口失败回归、共享草稿与固定请求、历史选择隔离、独立审查及离线浏览器验证；提交状态见实施基线。

- [编辑规则与讨论状态重构验收](archived/ARCHITECTURE_REFACTOR_ACCEPTANCE.md)：统一审核与保存、集中讨论推进、删除不可达 Job 代码；记录回归、CR 与离线浏览器验收。

- [2C 后阅读与导航打磨验收](archived/READING_NAVIGATION_ACCEPTANCE.md)：普通入口阅读、原文参照、精确导航及讲解总标题已通过离线验收；记录恢复修复、浏览器证据与限制。

- [第二阶段2C：Analysis与成果工具](archived/STAGE_2C_ANALYSIS_TOOLS.md)：生成并保存、确切修订读取、Section编辑／审核已完成离线验收；保留迁移、协议、浏览器及限制证据。

- [第二阶段 2B：片段后台异步问答](archived/STAGE_2B_ASYNC_QA.md)：已完成实现与离线验收；保留输入快照、原子锁定、持久历史、停止／重启、迁移及浏览器证据。

- [第二阶段 2A：设置与模型接入](archived/STAGE_2A_MODEL_SETTINGS.md)：已完成验收；保留接口、凭据、并发修复、迁移与浏览器证据。

- [第一阶段：素材与片段管理](archived/STAGE_1_SOURCE_SEGMENT.md)：已完成的首个领域切片，保留 API 契约、数据库策略与验收结果。
- [开发准备记录](archived/DEV_PREPARATION.md)：已完成的工程初始化、工具链与离线验证依据。
- [Occurrence 与 anchor 小样本试提取任务书](archived/ANCHOR_PILOT_AGENT_BRIEF.md)：实验任务记录；其 A0 规则和旧启动消息不是生产契约。

后续按选定切片更新相关规范，完成的阶段文档移入归档并保留结果与限制；不将执行记录复制到每份长期规范中。
