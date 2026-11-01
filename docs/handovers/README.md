# 阶段性交接

本目录维护当前实施基线、后续安排与仍在使用的回归规则。已完成计划、设计理由和验收证据按主题收录于 [Archived](#archived)；产品行为以 [PRD](../PRD.md) 为准，长期规范从[文档导航](../README.md)进入。

## 活动入口

| 要确认的问题 | 入口与职责 |
| --- | --- |
| 首个源码包的文档评审与发布前演练 | [候选包与恢复演练](BETA_SOURCE_CANDIDATE.md)，含本地候选标识、核验范围及正式发布前的步骤 |
| Windows 实验性支持怎样验证 | [Windows 验收与实机清单](WINDOWS_ACCEPTANCE.md)，覆盖源码运行、数据保护、阅读体验及自动验证限制 |
| 当前能力、实现差额与验证限制 | [MVP 实施基线](MVP_IMPLEMENTATION_BASELINE.md)，统一维护核对版本及验收入口 |
| EPUB 学习衔接接下来做什么 | [阶段安排](epub-reading/README.md#下一阶段接力顺序)：材料对话、消息引用和从讨论形成讲解；[接手提示词](epub-reading/AGENT_PROMPT.md)引用本安排 |
| 阅读实践还有哪些独立目标 | [实际阅读评测计划](reading-practice/PLAN.md)：扩展书内搜索、阅读设置迁移候选及数据保护 |
| 翻译、设备朗读与后续 adapter 如何继续验证 | [阅读辅助后续安排](epub-reading/README.md#阅读辅助后续安排)：真实样句、设备声音、资源预算与接入条件 |
| 句界、语境预算与定位有哪些固定预期 | [C2 精确样例](text-study/C2_EXACT_CASES.md)与 [文本资料验收矩阵](text-study/TEST_MATRIX.md)：现行规则和固定输入；实际结果由实施基线链接原验收 |

## Archived

归档保存当时的日期、代码与环境、参数、检查数字、浏览器观察和未验证项；旧接口与阶段假设用于理解历史，现行规则查负责规范。已完成验收中的设备实测等限制继续由实施基线承接，不作为保持活动状态的理由。

阅读设置调查中的缺省值线索与存储迁移候选已承接到[阅读评测计划](reading-practice/PLAN.md#阅读设置待评估事项)；EPUB 方向与定位方案的未完成设计已承接到[阶段安排](epub-reading/README.md#下一阶段接力顺序)。活动的 C2 规则、测试读取的固定数据、研究快照及原型样书保持原路径。

历史临时资产在 2026-10-24 清理；原书截图等私有证据的保留范围见[本机证据说明](archived/LOCAL_EVIDENCE.md)。历史 `temp/` 路径与启动命令记录当时环境，不能作为现成复现入口。公共路径与私有证据的检查入口见[开发指南](../DEVELOPMENT.md#文档与检查基准)。

### 阅读与学习阶段

| 范围 | 计划、设计与验收证据 |
| --- | --- |
| EPUB 设计与基础阅读 | [方向讨论](archived/epub-reading/DIRECTION.md)、[材料定位方案](archived/epub-reading/MATERIAL_BASELINE.md)、[切片 1 契约](archived/epub-reading/SLICE_1_DRAFT.md)、[章节调查](archived/epub-reading/CHAPTER_RESEARCH.md)、[切片 0 验收](archived/epub-reading/SLICE_0_ACCEPTANCE.md)、[切片 1 验收](archived/epub-reading/SLICE_1_ACCEPTANCE.md)、[章节位置记忆](archived/epub-reading/CHAPTER_MEMORY_ACCEPTANCE.md) |
| 阅读器与全量注音 | [R1.1 计划](archived/reader-r1/PLAN.md)、[API 快照](archived/reader-r1/API.md)、[工程验收](archived/reader-r1/ACCEPTANCE.md)、[交互优化](archived/reader-r1/INTERACTION_POLISH.md)、[注音计划](archived/full-ruby/PLAN.md)、[注音验收](archived/full-ruby/ACCEPTANCE.md) |
| 素材库与书籍管理 | [素材库计划](archived/library-a1/PLAN.md)、[封面 API 快照](archived/library-a1/API.md)、[素材库验收](archived/library-a1/ACCEPTANCE.md)、[书籍管理计划](archived/book-management/PLAN.md)、[书籍管理验收](archived/book-management/ACCEPTANCE.md) |
| 来源与片段入口 | [首轮素材与片段](archived/STAGE_1_SOURCE_SEGMENT.md)、[来源空间计划](archived/sources-s2/PLAN.md)、[来源空间验收](archived/sources-s2/ACCEPTANCE.md)、[片段目录与删除](archived/SEGMENT_CATALOG_ACCEPTANCE.md)、[专注布局计划](archived/segment-layout/PLAN.md)、[专注布局验收](archived/segment-layout/ACCEPTANCE.md) |
| 文本处理、统计与人工资料 | [历史计划](archived/text-study/PLAN.md)、[S0 规范收口](archived/text-study/S0_ACCEPTANCE.md)、[B1 文本分析](archived/text-study/B1_ACCEPTANCE.md)、[B2 统计](archived/text-study/B2_ACCEPTANCE.md)、[A1 独立回看](archived/text-study/A1_ACCEPTANCE.md)、[A2 人工资料](archived/text-study/A2_ACCEPTANCE.md) |
| 精确出处与阅读体验 | [阅读体验计划](archived/text-study/READING_EXPERIENCE_PLAN.md)、[C1 出处](archived/text-study/C1_ACCEPTANCE.md)、[C2 学习往返](archived/text-study/C2_ACCEPTANCE.md)、[阅读标记](archived/text-study/READER_MARKS_ACCEPTANCE.md)、[阅读体验](archived/text-study/READING_EXPERIENCE_ACCEPTANCE.md)、[保存表单](archived/text-study/SEGMENT_SAVE_FORM_ACCEPTANCE.md)、[原处预览](archived/text-study/INLINE_PREVIEW_ACCEPTANCE.md) |
| 阅读辅助与片段操作 | [翻译朗读原方案](archived/text-study/TRANSLATION_AND_SPEECH_PLAN.md)、[翻译朗读验收](archived/text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md)、[片段资料操作](archived/text-study/SEGMENT_UI_ACCEPTANCE.md)、[正文复制](archived/text-study/READER_COPY_ACCEPTANCE.md)、[阅读会话与加载测量](archived/text-study/READER_SESSION_ACCEPTANCE.md) |
| 讨论、模型与成果工具 | [模型接入契约](archived/STAGE_2A_MODEL_SETTINGS.md)、[问答历史契约](archived/STAGE_2B_ASYNC_QA.md)、[Analysis 与成果工具](archived/STAGE_2C_ANALYSIS_TOOLS.md)、[上下文与统一讲解](archived/AGENT_CONTEXT_ACCEPTANCE.md)、[学习导航打磨](archived/READING_NAVIGATION_ACCEPTANCE.md) |
| 页面与设置整理 | [前端计划](archived/frontend-refresh/PLAN.md)、[API 快照](archived/frontend-refresh/API.md)、[前端验收](archived/frontend-refresh/ACCEPTANCE.md)、[未来备忘](archived/frontend-refresh/FUTURE_NOTES.md)、[设置分类计划](archived/settings-refresh/PLAN.md)、[设置分类验收](archived/settings-refresh/ACCEPTANCE.md)、[模型服务二级切换](archived/SETTINGS_MODELS_ACCEPTANCE.md) |

### 阅读实践与设置

| 范围 | 计划、设计与验收证据 |
| --- | --- |
| 带上下文复制 | [首版验收](archived/reading-practice/CONTEXT_COPY_ACCEPTANCE.md)、[数据库持久化与现用库升级](archived/reading-practice/CONTEXT_COPY_DATABASE_ACCEPTANCE.md) |
| 阅读设置 | [结构调查与原型记录](archived/reading-practice/READER_SETTINGS_STRUCTURE.md)、[结构与会话保护验收](archived/reading-practice/READER_SETTINGS_ACCEPTANCE.md) |
| 应用设置 | [自动保存、服务管理与验证记录整理验收](archived/settings-refresh/POLISH_ACCEPTANCE.md) |
| 位置书签 | [首版与主分支集成](archived/reading-practice/BOOKMARKS_ACCEPTANCE.md)、[附近提醒与详情改进](archived/reading-practice/BOOKMARK_REFINEMENT_ACCEPTANCE.md) |
| 即时查词与记录浮窗 | [词典试读与管理](archived/epub-reading/DICTIONARY_PLAN.md)、[阅读浮窗验收](archived/reading-practice/READER_POPOVER_ACCEPTANCE.md) |
| 翻译、配色与词汇 | [翻译动画、缓存与删除](archived/reading-practice/TRANSLATION_RELIABILITY_ACCEPTANCE.md)、[阅读器颜色 token](archived/reading-practice/READER_COLOR_TOKENS_ACCEPTANCE.md)、[材料词汇与统计更新](archived/reading-practice/VOCABULARY_ACCEPTANCE.md) |

### 工程、性能与可靠性

| 范围 | 计划、设计与验收证据 |
| --- | --- |
| Windows 源码运行 | [本机与七轮 CI 记录](archived/WINDOWS_CI_ACCEPTANCE.md)；未完成的实机检查继续使用[活动清单](WINDOWS_ACCEPTANCE.md) |
| 数据库与存储 | [开发期基线](archived/DATABASE_BASELINE_ACCEPTANCE.md)、[迁移基线整理](archived/DATABASE_MIGRATION_ACCEPTANCE.md)、[EPUB 编译存储](archived/EPUB_STORAGE_ACCEPTANCE.md)、[材料独立删除](archived/MATERIAL_DELETION_ACCEPTANCE.md)、[导入书卡反馈](archived/EPUB_IMPORT_FEEDBACK_ACCEPTANCE.md) |
| 主题与加载 | [Reader 主题](archived/READER_THEME_ACCEPTANCE.md)、[整站主题](archived/APPLICATION_THEME_ACCEPTANCE.md)、[图片查看器测量](archived/epub-reading/IMAGE_VIEWER_PERFORMANCE_ACCEPTANCE.md)、[路由按需加载](archived/ROUTE_LOADING_ACCEPTANCE.md)、[后端读取测量](archived/READER_READ_PERFORMANCE_ACCEPTANCE.md) |
| 状态与执行结构 | [编辑规则与讨论状态](archived/ARCHITECTURE_REFACTOR_ACCEPTANCE.md)、[事务与后台可靠性](archived/ARCHITECTURE_RELIABILITY_ACCEPTANCE.md)、[阅读恢复与来源导航](archived/READER_STATE_REFACTOR_ACCEPTANCE.md)、[阅读跳转](archived/READER_NAVIGATION_REFACTOR_ACCEPTANCE.md)、[翻译会话](archived/TRANSLATION_SESSION_REFACTOR_ACCEPTANCE.md)、[方向切换修复](archived/READER_LAYOUT_SWITCH_ACCEPTANCE.md)、[呈现协调](archived/READER_PRESENTATION_REFACTOR_ACCEPTANCE.md) |
| 测试与维护 | [CR 修复](archived/CR_FIXES_ACCEPTANCE.md)、[测试质量整改](archived/TEST_QUALITY_ACCEPTANCE.md)、[测试清理与入口回归](archived/TEST_CLEANUP_ACCEPTANCE.md)、[维护四批与学习闭环复验](archived/MAINTENANCE_OPTIMIZATION.md) |
| 工程与研究起点 | [开发准备](archived/DEV_PREPARATION.md)、[anchor 试提取任务书](archived/ANCHOR_PILOT_AGENT_BRIEF.md)、[本机证据保留说明](archived/LOCAL_EVIDENCE.md) |
