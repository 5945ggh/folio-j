# 第一轮 MVP 实施基线

> 状态核对：2026-11-17，以 `main b89189ab` 为起点，`codex/reader-lookup-continuity` 分支落实查词连续性与键盘滚动调整。本文件说明该开发快照的能力、缺口与验证范围；发布包的版本、附件和实际验收以 [beta.1](https://github.com/5945ggh/folio-j/releases/tag/v0.1.0-beta.1)／[beta.2](https://github.com/5945ggh/folio-j/releases/tag/v0.1.0-beta.2)发布记录为准。

产品规则见 [PRD](../PRD.md)与[领域术语](../GLOSSARY.md)，实现机制见[架构](../ARCHITECTURE.md)，具体交互见[阅读与导航](../INFORMATION_ARCHITECTURE.md)。后续安排从 [EPUB 阶段](epub-reading/README.md)和[阅读评测计划](reading-practice/PLAN.md)进入；历次实施起点、修复经过和检查结果由[验收索引](README.md#archived)承接。

beta.3 发行范围为源码包与样书；11 月 16 日决定暂缓 Windows 免安装包，目录访问故障与选择交互留待独立修复。候选与验证见[发布准备](BETA_3_RELEASE_ACCEPTANCE.md)，正式附件见[发布记录](https://github.com/5945ggh/folio-j/releases/tag/v0.1.0-beta.3)。

## 1. 当前实现、差额与验收依据

| 能力 | 当前状态与边界 | 规范与验收入口 |
| --- | --- | --- |
| 本地运行与发行 | 源码启动、备份恢复及数据位置选择已实现；跨程序更新记住学习库，记忆写入失败不阻断本次使用，损坏或失效位置进入恢复。PyInstaller 目录包仍为实验，不替代正式源码 ZIP；没有目录扫描或搬迁 | [使用指南](../USAGE.md)、[升级与备份](../UPGRADING.md)、[源码包验收](BETA_2_RELEASE_ACCEPTANCE.md)、[目录包试做](archived/PYINSTALLER_ACCEPTANCE.md)、[数据位置验收](archived/DATA_LOCATION_ACCEPTANCE.md) |
| Windows 支持 | 实验性支持 PowerShell 源码运行与原生冻结包。已有源码 CI 和特定提交的冻结包构建、原目录及 ZIP 冒烟证据，Windows 11 实机与最新数据位置流程仍待复验 | [当前清单](WINDOWS_ACCEPTANCE.md)、[源码 CI](archived/WINDOWS_CI_ACCEPTANCE.md)、[冻结包验收](archived/WINDOWS_FROZEN_ACCEPTANCE.md) |
| 来源、素材库与书籍管理 | Source／Segment 手动录入、语境与编辑；跨来源书籍目录及来源概览、素材、片段、讲解视图；书籍导入反馈、封面与元信息编辑、阅读状态和最近打开已实现。移动书籍、替换 EPUB 及其他媒体入口未开放 | [来源空间验收](archived/sources-s2/ACCEPTANCE.md)、[书籍管理验收](archived/book-management/ACCEPTANCE.md)、[导入反馈](archived/EPUB_IMPORT_FEEDBACK_ACCEPTANCE.md) |
| EPUB 阅读与恢复 | 托管原书及不可变编译包，支持目录、连续图文、横竖排、章节位置、相邻切章、跳转返回和图片查看。阅读会话往返保留正文与 iframe，返回重新核验；位置写入、重排与迟到响应隔离已覆盖 | [阅读器验收](archived/reader-r1/ACCEPTANCE.md)、[交互复核](archived/reader-r1/INTERACTION_POLISH.md)、[章节位置](archived/epub-reading/CHAPTER_MEMORY_ACCEPTANCE.md)、[呈现协调](archived/READER_PRESENTATION_REFACTOR_ACCEPTANCE.md)、[章末裁剪](archived/reading-practice/READER_SCROLLBAR_ACCEPTANCE.md) |
| 注音、文本统计与词汇 | 注音范围可选原书或全量，全量仅补未被原书 ruby 覆盖的汉字；分词资产、失败保留、代次更新、位置与选区恢复已实现。书籍详情提供文本统计，材料词表支持筛选、分页与返回原文，尚无积累库 | [全量注音](archived/full-ruby/ACCEPTANCE.md)、[文本分析](archived/text-study/B1_ACCEPTANCE.md)、[统计](archived/text-study/B2_ACCEPTANCE.md)、[材料词汇](archived/reading-practice/VOCABULARY_ACCEPTANCE.md) |
| 本书搜索 | 原文、片段、最新阅读译文和书签分组检索，支持章节与内容组合筛选、空词浏览、分页及会话恢复。结果复用精确定位和只读预览，按类型核验，保留失配与删除门禁 | [搜索交互](../INFORMATION_ARCHITECTURE.md#本书搜索)、[搜索验收](archived/reading-practice/BOOK_SEARCH_ACCEPTANCE.md)、[按类预览复核](archived/REVIEW_FOLLOWUP_20261113.md#搜索结果预览) |
| 复制与书签 | 正文复制排除注音；带上下文复制的默认配置自动保存。位置书签可浏览、删除和返回；材料删除后保留并隐藏，不向重导材料换绑 | [正文复制](archived/text-study/READER_COPY_ACCEPTANCE.md)、[上下文复制](archived/reading-practice/CONTEXT_COPY_ACCEPTANCE.md)、[书签验收](archived/reading-practice/BOOKMARK_REFINEMENT_ACCEPTANCE.md)、[偏好保护取舍](archived/reading-practice/PROTECTION_SIMPLIFICATION_ACCEPTANCE.md) |
| 选区学习与原处回看 | 选区可保存为带精确出处的片段，支持语境预装、编辑保护和返回原句；正文标记、页边入口、本章记录及紧凑／完整预览读取已有译文与讲解 | [C1](archived/text-study/C1_ACCEPTANCE.md)、[C2](archived/text-study/C2_ACCEPTANCE.md)、[原处预览](archived/text-study/INLINE_PREVIEW_ACCEPTANCE.md)、[记录浮窗回归](../../frontend/browser-tests/chapter-records.tsx)、[页边入口回归](../../frontend/browser-tests/margin-record-targets.tsx) |
| 持久讲解与片段讨论 | 人工 Markdown 保存和 AI 工具保存共用内容保护；支持多份 Analysis、不可变修订、全文修订、块编辑与审核。讨论按需启动，提供持久线程、冻结上下文、预算、停止及恢复；创建 AI 讲解进入普通对话，普通提问默认不保存讲解 | [人工资料](archived/text-study/A2_ACCEPTANCE.md)、[工具与修订](archived/STAGE_2C_ANALYSIS_TOOLS.md)、[统一讨论验收](archived/AGENT_CONTEXT_ACCEPTANCE.md)、[上下文预算](archived/REVIEW_FOLLOWUP_20261113.md#聊天上下文预算)、[回复反馈回归](../../frontend/browser-tests/workbench-render.tsx) |
| 阅读翻译与设备朗读 | 选区翻译、历史版本、片段原子采用及整组删除已实现；同目标入口共用草稿与请求，原处和本章记录可回看。设备朗读支持声音、语速及重播；片段页选区可独立朗读，与阅读器共用工具栏呈现，完整资料弹窗内可控制播放；独立采用、单版删除入口已退出，外部 TTS 后置 | [翻译与朗读验收](archived/text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md)、[会话状态](archived/TRANSLATION_SESSION_REFACTOR_ACCEPTANCE.md)、[缓存与删除](archived/reading-practice/TRANSLATION_RELIABILITY_ACCEPTANCE.md)、[独立采用与单版删除退出](archived/reading-practice/PROTECTION_SIMPLIFICATION_ACCEPTANCE.md#自用-api-调整)、[译文操作行回归](../../frontend/browser-tests/translation-toolbar.tsx)、[片段选区回归](../../frontend/browser-tests/segment-dictionary.tsx) |
| 即时查词 | EPUB、片段原文／语境／讲解共用词卡与偏好；多部词典安装、选择和删除，兼容旧索引。已支持词形还原、扩展、排序、卡内查词与活用说明；无释义词典时可使用基础词卡，命中时仍显示原文词法信息；阅读器划选工具栏按用途分组，阅读器与片段页关闭自动查词仍可手动选查；片段查词开启提示复用公共颜色 token；辅助选项原位刷新根卡，真实悬浮保留原焦点 | [基础词卡](reading-practice/DICTIONARY_BASELINE_ACCEPTANCE.md)、[粒度对照实验](reading-practice/DICTIONARY_GRANULARITY_EXPERIMENT.md)、[片段接入](reading-practice/SEGMENT_DICTIONARY_ACCEPTANCE.md)、[活用说明](archived/reading-practice/DICTIONARY_INFLECTION_ACCEPTANCE.md)、[辅助选项](reading-practice/DICTIONARY_OPTIONS_ACCEPTANCE.md)、[查词连续性与键盘滚动](reading-practice/READER_LOOKUP_CONTINUITY_ACCEPTANCE.md)、[操作与兼容](../USAGE.md#即时查词) |
| 导航、设置与呈现 | 阅读／片段可进入全局设置并保留适用范围内的草稿和阅读会话；讨论内可配置模型，恢复配置后显式继续。阅读设置分组、应用主题、独立纸面和共享浮窗已实现，方向键步长随排版变化；多套阅读配色尚未开放 | [全局导航验收](archived/reading-practice/FOCUSED_NAVIGATION_ACCEPTANCE.md)、[设置返回回归](../../frontend/browser-tests/settings-return.tsx)、[模型配置回归](../../frontend/browser-tests/model-setup.tsx)、[设置验收](archived/settings-refresh/POLISH_ACCEPTANCE.md)、[交互契约](../INFORMATION_ARCHITECTURE.md#阅读设置分组与会话)、[设计系统](../DESIGN_SYSTEM.md) |
| 编辑与删除保护 | 片段原文按受理、保存和精确出处规则固定；长内容继续保留冲突与失败输入保护。轻量改名、复制偏好和删除复核已按风险减负。删书默认保留学习积累，可选择清理本书精确关联内容；来源删除清理下属托管资源，失败整体回滚 | [保护取舍](archived/reading-practice/PROTECTION_SIMPLIFICATION_ACCEPTANCE.md)、[可选清理验收](reading-practice/BOOK_DELETE_LEARNING_ACCEPTANCE.md)、[来源清理验收](archived/SOURCE_DELETION_CLEANUP_ACCEPTANCE.md)、[PRD F2](../PRD.md#f2-source-与片段) |
| 数据存储与升级 | 迁移支持空库重建与已支持旧库的增量升级，迁移入口使用数据库排他锁；备份包含主库、凭据及词典。EPUB 使用 v2 图片池编译格式，没有旧格式读取、回退或转换工具 | [迁移链及旧库边界](../UPGRADING.md)、[迁移保护验收](archived/REVIEW_FOLLOWUP_20261113.md#迁移入口保护)、[EPUB 存储验收](archived/EPUB_STORAGE_ACCEPTANCE.md)、[现用库升级核对](archived/reading-practice/TRANSLATION_RELIABILITY_ACCEPTANCE.md#现用库与原目录交付) |
| 工程与维护验证 | 已有离线 API、纯逻辑和真实组件浏览器回归；公共文档与私有证据分别检查。合成学习闭环覆盖重启后找回修订并返回原句，近期测试收敛保留行为保障 | [学习闭环复验](archived/MAINTENANCE_OPTIMIZATION.md)、[测试收敛](archived/TEST_CLEANUP_ACCEPTANCE.md#2026-11-13-维护审计后的断言收敛)、[开发检查入口](../DEVELOPMENT.md) |

### 验证限制

- **内容与格式**：支持普通可重排 EPUB；兼容的固定图片 spine 页仅保留图像，不恢复固定几何；封面缓存限有界静态 PNG／JPEG。具体边界见[EPUB 编译与存储格式](../ARCHITECTURE.md#epub-编译与存储格式)及[目录与材料使用状态中的封面规则](../ARCHITECTURE.md#311-目录与材料使用状态)。
- **用户使用与设备**：书籍管理、可选清理学习积累和来源空间仍待用户使用验收；阅读页入场手感待试。Windows 实机、普通权限下数据目录访问与最新位置恢复流程见[Windows 清单](WINDOWS_ACCEPTANCE.md)。实体触屏、Safari／Firefox、浏览器扩展及系统剪贴板的已测范围见[阅读器限制](archived/reader-r1/ACCEPTANCE.md#明确未验证与限制)和[图片查看器验收](archived/epub-reading/IMAGE_VIEWER_PERFORMANCE_ACCEPTANCE.md#提交前-cr-修复2026-10-27)。早期 Yomitan 试读结果不代表后续阅读器已完整验证。
- **真实内容与模型**：新增活用说明的真实词典试读、原地模型配置的真实接入、讨论回复节奏、真实翻译质量及资源预算、设备声音仍需按[EPUB 后续安排](epub-reading/README.md#阅读辅助后续安排)和原验收补测。Chrome 语速调整目前仅确认参数传递，用户听感未变化的根因与实际效果仍未确认，见[调查记录](archived/text-study/SEGMENT_UI_ACCEPTANCE.md#chrome-语速问题调查)。
- **规模与测量**：本书搜索的真实大型书库性能待验证；会话复用未显示离线可读时间稳定下降，整合后的生产冷加载未重测。原测量仅适用于当时版本与环境，见[搜索计划](reading-practice/PLAN.md)、[会话测量](archived/text-study/READER_SESSION_ACCEPTANCE.md)及[冷加载验收](archived/ROUTE_LOADING_ACCEPTANCE.md)。

## 2. 尚未落实的契约与目标差额

人工资料、文本统计和 C1／C2 已交付；材料对话、从讨论形成讲解及 Occurrence 链路仍按阶段安排推进。

| 缺口 | 负责规范 | 实施前需要明确或补齐的内容 |
| --- | --- | --- |
| 保存片段时的模型预选 | [PRD F1](../PRD.md#f1-设置) | 保存片段预选模型与普通讲解对话默认模型之间的适用对象、保存位置和继承关系尚未收口；先对齐产品契约，不能因旧生成分支停用而取消预选要求 |
| EPUB 学习衔接 | [PRD 后续范围](../PRD.md#材料对话与讲解的后续范围)、[阶段安排](epub-reading/README.md) | 材料线程、消息引用、读取权限与费用，以及从讨论整理讲解的目标和部分成功反馈 |
| Occurrence 生产契约 | [术语](../GLOSSARY.md#4-知识表示与提取边界已对齐)、[PRD F5](../PRD.md#f5-学习条目创建与整理)、`TBD-02/03` | 持久字段与类型边界、不连续 Surface／重复文字定位、anchor 及多个 Section 的确切引用；[A0 实验](../../references/occurrence_anchor_pilot/batch-01/report.md)不作为生产定案 |
| 条目读取与候选写入 | [PRD F5](../PRD.md#f5-学习条目创建与整理)、[F9](../PRD.md#f9-agent-工具权限与审核) | 尚无 Occurrence 持久化、读取／候选工具或用户整理操作；将已确认边界落实为接口和执行校验 |
| 组合操作与恢复 | [PRD F8](../PRD.md#f8-状态与诊断)、[架构](../ARCHITECTURE.md#45-讨论与成果保存analysis已实现occurrence待设计)、`TBD-16/17` | Occurrence 的逐项结果、幂等身份、保存核实、局部修复、统一预算与混合方案审核；Analysis 已实现部分沿用现有机制 |
| 积累阅读与删除关联 | [PRD F6](../PRD.md#f6-知识库)、[F2](../PRD.md#f2-source-与片段) | 尚无积累库页面、条目检索、anchor 分组与整理；需接通原句、确切来源 Section 和真实删除影响。当前 Analysis 删除影响中的 `occurrence_count` 固定为 `0`，尚未查询条目引用 |

讨论不要求先有 Analysis；创建条目依赖持久、自足讲解和确切原文定位。手动片段学习继续独立可用，KnowledgePoint 归属与主动学习不在当前阶段范围。

## 3. 验收与交接

实施任务需连通前端、接口与持久化，并按 [PRD 成功标准](../PRD.md#8-成功标准)、[架构测试策略](../ARCHITECTURE.md#8-测试策略)和 [AGENTS](../../AGENTS.md)验证。Occurrence 落地时补齐原文定位、历史引用、跨片段隔离、状态竞争、软删除与迟到结果、再次整理及部分成功恢复。

离线 fixture、真实模型接入、教学内容质量与实际学习体验分别记录；测试禁止真实网络与模型调用。完成后将规则写回负责规范、证据归档并更新本基线；旧方案和实验不能补定未决事项。
