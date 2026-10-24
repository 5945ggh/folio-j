# 第一轮 MVP 实施基线

> 本轮 CR 修复已覆盖EPUB 完整产物预算、EPUB 多目录编译、审核批准与附加要求、失败残文保留、流式持久化节流、历史分页与轻量摘要、稳定历史渲染；回归与独立复审证据见[本轮 CR 修复验收](CR_FIXES_ACCEPTANCE.md)。

> 状态核对：2026-10-24，材料独立删除已提交。文本与资料调整以 `85d8725` 为代码起点，S0／B1 分别提交为 `4e705a1`／`bb900ce`，B2 提交为 `3f6491f`，A1 提交为 `13de4e9`，A2 提交为 `367f4f4`；A 线完成；C1 已提交 `290a6a0`，C2 已提交 `7eaedbe` 并完成工程与浏览器验收；阅读标记交互已提交 `c389ca3`。后续阅读体验调整及验收已提交，结果和限制见[阅读体验记录](text-study/READING_EXPERIENCE_ACCEPTANCE.md)；保存表单优化见[独立验收](text-study/SEGMENT_SAVE_FORM_ACCEPTANCE.md)。当前增量迁移及已有能力的证据见下表和历史记录。
> 原处预览以 `54214a2` 为起点，实现已提交 `cbf5851`，工程、独立审查及浏览器验收通过；用户认可当前视觉效果，后续在实际阅读中继续迭代。见[原处预览验收](text-study/INLINE_PREVIEW_ACCEPTANCE.md)。
> 横排段尾译文、宽屏记录浮窗拖动停驻及开合性能修复已提交 `87a217e`，工程、全量浏览器及独立复核通过；后续开合卡顿已修复，长章节回归约束每次开合只进行一次整章重排；见[本轮验收](text-study/INLINE_PREVIEW_ACCEPTANCE.md#段尾译文与可拖动记录浮窗2026-10-24)。
> 段尾译文平滑开合已提交，用户试读确认效果；译文与阅读区真实高度、padding、透明度同步变化，保留页边浮窗交接、快速反向、原文位置与长章性能，作者变换布局安全回退；见[提交前复核](text-study/INLINE_PREVIEW_ACCEPTANCE.md#译文开合提交前复核2026-10-24)。
> 页边点击清选区、正文／页边分别定位和翻译卡片精简已提交 `58ffe61`，工程、全量浏览器及独立审查通过；见[本轮验收](text-study/INLINE_PREVIEW_ACCEPTANCE.md#页边点击入口定位与翻译卡片2026-10-24)。
> 学习片段预览往返与记录列表精简已提交 `2d06a38`：完整阅读侧栏支持“收起”回到预览，保留目标、类型标签、片段／讲解选择与临时手动位置；本章记录讲解完整展示并支持滚动，此处记录的紧凑讲解按实际截断渐隐，操作前置、保存信息底部折叠；片段列表去除提示和 ID 后缀，时间精简到分钟，翻译列表仅显示原文与译文。工程、联合浏览器验收与独立复核通过，见[调整范围](text-study/INLINE_PREVIEW_ACCEPTANCE.md#记录列表与学习片段预览调整2026-10-24)与[联合验收](text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md#本章记录与学习片段联合验收2026-10-24)。
> 翻译保存入口与临时定位高亮已分批提交至 `7c70d67`：Reader 新建统一从正文划选进入，草稿可预填并编辑／清空匹配译文，创建时原子留存关联收据；翻译详情保留打开已关联片段。返回原处与书内搜索的临时高亮稳定显示 2.5 秒后以 260ms 淡出，减少动态效果跳过动画，重排不续期。工程、联合浏览器验收与独立复核通过，见[联合验收与限制](text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md#本章记录与学习片段联合验收2026-10-24)及[提交清单](text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md#记录与保存调整分批提交2026-10-24)。
> 产品范围以 [PRD.md](../PRD.md) 为准，领域含义以 [GLOSSARY.md](../GLOSSARY.md) 为准，技术方案以 [TECH_STACK.md](../TECH_STACK.md) 为准。
> 本文件汇总当前能力、实现缺口和阶段验收；产品规则链接至负责规范。
> 阅读跳转深化已提交，工程及浏览器验收已通过；证据见[本轮验收](archived/READER_NAVIGATION_REFACTOR_ACCEPTANCE.md)。
> 阅读翻译与设备朗读、片段资料与讨论面板、阅读器正文复制已提交 `7f1c44d`。提交前问题已修复，工程、全量浏览器与独立复审通过；证据见[阅读辅助联合验收](text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md#2026-10-23提交前审查修复与联合验收)。
> 翻译卡片、朗读控制、本章记录与正文翻译标记已分批提交，界面集成提交为 `3ec616e`；2026-10-24 通过工程、全量浏览器及独立复审，见[交互调整](text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md#2026-10-23-翻译卡片与朗读控制交互调整)与[本章记录验收](text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md#2026-10-24-本章记录与正文翻译标记)。
> 片段复制分享、片段页底部朗读浮层及共享迷你播放器调整已提交 `8b945c8`，浏览器回归修复已提交 `9d55e2e`。来源首次加载保护、双出处失败短屏操作、适度加深的前后文灰阶均通过工程、全量浏览器与独立复审；真实设备行为仍需试用。见[提交前联合验收](text-study/SEGMENT_UI_ACCEPTANCE.md#提交前修复与联合验收2026-10-24)。
> 设备语速存在用户复核异常：Chrome 中多种音色修改语速并从头重播后，听感仍无变化；目前只验证了参数传递，根因与实际变速效果未确认。调查记录见[Chrome 语速问题](text-study/SEGMENT_UI_ACCEPTANCE.md#chrome-语速问题调查)。
> 手动试用调整已提交：同出处历史译文条目省略重复原句，顶部详情保留原句；移除底部“最近翻译”及其专用视图和旧任务重做分支。范围与检查见[手动试用记录](text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md#手动试用调整与注音调查2026-10-24)。
> 全量注音词首假名修复已提交：“まな板”仅在“板”标“いた”，保留整词核验、原书注音保护及原文选区；无需重建分词数据。范围与检查见[后续验收](text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md#自动注音词首假名修复2026-10-24)。

当前能力与缺口见下表，产品边界见 [PRD 4.7](../PRD.md#47-当前-epub-阶段安排)，后续顺序与准备条件由[EPUB 阶段入口](epub-reading/README.md)维护。

## 1. 当前实现、差额与验收依据

| 能力 | 状态 | 当前能力与边界 | 验收依据 |
| --- | --- | --- | --- |
| 来源与片段 | 已提交 | Source／Segment 手动录入、语境、编辑、逻辑删除与持久化；片段原文在首次 AI 任务受理、讲解成功保存或精确出处创建后锁定；旧资料由增量迁移补齐保护 | [第一阶段](archived/STAGE_1_SOURCE_SEGMENT.md)、[2B](archived/STAGE_2B_ASYNC_QA.md)、[A2 验收](text-study/A2_ACCEPTANCE.md) |
| 设置与模型接入 | 已提交、工程验收通过 | 学习背景、讲解预设、Provider／模型／用途默认值、模型发现及普通／流式文本验证；顶部分类、统一编辑弹窗、分组原子保存、草稿保护与验证记录筛选 | [2A](archived/STAGE_2A_MODEL_SETTINGS.md)、[设置调整验收](archived/settings-refresh/ACCEPTANCE.md) |
| 阅读翻译与设备朗读 | 已提交，基础能力经全量浏览器验证；译文标题栏工具与选区拖动经工程、定向浏览器及只读复审通过 | 选区翻译、持久找回、原子采用、版本冲突保护；本章记录分片段／翻译，同出处成功译文归并标记、重叠入口合并，后台完成自动刷新；译文卡标题栏重译／停止、旧文保留与相邻版本回看，宽屏拖动、窄屏停靠；设备支持时可暂停／继续，结束后原条保留并切换重播，声音语速就地调整；真实模型质量与设备声音待实测，外部 TTS 后置 | [方案](text-study/TRANSLATION_AND_SPEECH_PLAN.md)、[验收与限制](text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md)、[标题栏与拖动验收](text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md#选区译文标题栏工具与拖动2026-10-24)、[播放器联合验收](text-study/SEGMENT_UI_ACCEPTANCE.md#提交前修复与联合验收2026-10-24) |
| 正文划选保存译文与临时定位高亮 | 已提交，工程、联合浏览器验收及独立复核通过 | 翻译详情移除新建及独立采用入口；正文草稿按确切位置及整体边缘空白规则匹配成功译文，一次预填并保护编辑／清空与冻结提交；原子创建采用收据；搜索及返回原处临时强调共用生命周期与淡出 | [联合验收与限制](text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md#本章记录与学习片段联合验收2026-10-24)、[PRD 4.8](../PRD.md#48-阅读翻译与设备朗读) |
| 翻译会话状态归属 | 已提交 `8f6ce79`，工程、全量浏览器及独立复核通过 | 同目标双入口共用草稿和固定请求，历史选择分别保存；集中生成门禁、原请求核实、recent 重做与 Reader 生命周期 | [本轮验收](archived/TRANSLATION_SESSION_REFACTOR_ACCEPTANCE.md) |
| 片段讨论 | 已提交，面板调整通过工程、浏览器及独立复审 | 持久线程、后台工具循环、输入快照、停止、重启恢复与线程权限；单行标题、可展开引用、助手全宽消息及独立设置浮层；读取工具覆盖当前 Segment 的讲解，聊天历史限于本线程 | [2B](archived/STAGE_2B_ASYNC_QA.md)、[2C](archived/STAGE_2C_ANALYSIS_TOOLS.md)、[界面调整验收](text-study/SEGMENT_UI_ACCEPTANCE.md) |
| 持久讲解 | 已提交，工程与浏览器验收通过 | 直接编写／粘贴 Markdown 保存，统一记录用户保存；当前全文修订、冲突保稿与同请求核实；多份 Analysis、不可变 Revision／Section；AI 快捷生成、块编辑与审核沿用原流程 | [2C](archived/STAGE_2C_ANALYSIS_TOOLS.md)、[A2 验收](text-study/A2_ACCEPTANCE.md) |
| 片段阅读与导航 | 已提交；内容聚合、浮层稳定性与讲解导航通过工程、浏览器及独立审查 | 窄工具栏／中央阅读／右侧讨论，进入隐藏全局导航；出处分书名／章名与定位入口，后台核对保持布局；原文／语境／当前译文及只读关联记录集中，朗读仅目标；完整资料浮层与讲解身份保留；纯回看不挂载讨论，激活后保活，窄屏切换保留草稿与阅读位置；确切修订、来处返回和人工编辑保护沿用原规则 | [阅读导航](archived/READING_NAVIGATION_ACCEPTANCE.md)、[架构重构](archived/ARCHITECTURE_REFACTOR_ACCEPTANCE.md)、[A1 验收](text-study/A1_ACCEPTANCE.md)、[专注布局](archived/segment-layout/ACCEPTANCE.md)、[资料界面调整](text-study/SEGMENT_UI_ACCEPTANCE.md)、[内容聚合验收](text-study/SEGMENT_UI_ACCEPTANCE.md#片段内容聚合2026-10-24)、[讲解头部验收](text-study/SEGMENT_UI_ACCEPTANCE.md#讲解标题与工具栏2026-10-24)、[创建与导航](text-study/SEGMENT_UI_ACCEPTANCE.md#列表创建与文档导航2026-10-24) |
| 素材库与阅读管理 | 已提交 | 跨 Source 书籍目录、搜索／筛选／排序／分页、书卡大小与状态菜单、空库整区导入；阅读三态和最近打开持久化，封面按规则版本 2 回退与缓存 | [前端调整](archived/frontend-refresh/ACCEPTANCE.md)、[素材库 A.1](archived/library-a1/ACCEPTANCE.md) |
| 导入来源表单 | 已提交，工程检查通过；用户反馈无阻塞问题 | 添加书籍与新建来源完整视图切换，创建后自动选择来源并保留文件；单组操作、中文文案与表单提交保护 | [导入来源表单调整](archived/library-a1/ACCEPTANCE.md#2026-10-19-导入来源表单调整) |
| 书籍管理 | 已提交，提交前工程、独立审查与浏览器复核通过；用户使用验收待进行 | 紧凑菜单与阅读状态二级入口、真实详情、书名与封面原子编辑／恢复、草稿／冲突保护及安全返回；公共默认外壳已统一并清理旧样式；移动仍禁用，不替换 EPUB；独立删除见下行 | [现行契约](../ARCHITECTURE.md#311-目录与材料使用状态)、[验收记录](archived/book-management/ACCEPTANCE.md) |
| 材料独立删除 | 已提交，工程、独立审查与浏览器验收通过 | 素材库与来源书卡删除材料并清空托管原书与派生阅读数据，保留材料身份、Source、片段、讲解、讨论及其他材料；完整访问门禁、幂等删除、目录计数与缓存隔离；重导创建新身份，移动与一并删除继续后置 | [产品规则](../PRD.md#421-本轮材料目录与阅读管理)、[验收记录](MATERIAL_DELETION_ACCEPTANCE.md) |
| 来源空间 S2 | 已提交 | 三栏及概览／素材／片段／讲解四视图、有界概览、来源分页、确切修订直达、视图／窗口／来处恢复；来源栏可调宽并保存偏好，片段／讲解列表搜索、排序与空态已打磨；工程验收完成，用户使用验收待进行 | [S2 工程验收](archived/sources-s2/ACCEPTANCE.md) |
| EPUB 导入与恢复 | 已提交 | 来源下导入、原书与不可变编译包托管、同源同字节复用、目录组章与连续图文、横竖排／字号／行距、持久位置与重排恢复；Source 删除后材料不可读，托管字节暂保留 | [切片 1](archived/epub-reading/SLICE_1_ACCEPTANCE.md)、[定位试验](archived/epub-reading/SLICE_0_ACCEPTANCE.md) |
| 阅读器 R1.1 | 已提交 | 独立阅读空间、专注／主题／字体／宽度／原书 ruby、书内字面搜索、插图库／大图和会话跳转原点；左右工具面板独立，保留正文交互及关闭层级 | [R1.1 工程验收](archived/reader-r1/ACCEPTANCE.md)、[交互优化](archived/reader-r1/INTERACTION_POLISH.md) |
| UI 深浅主题适配 | 已提交，工程、全量浏览器及独立审查通过 | 公共页面保持浅色、Reader 独立主题；修复确认框、作者样式覆盖、讲解预览、错误提示、目录选中进度及辅助文字可读性 | [本轮验收](READER_THEME_ACCEPTANCE.md) |
| 阅读工具栏透明度 | 已提交、工程验收通过 | 上下栏统一透明度、轻微模糊、跨书偏好与恢复默认；横排顶部透文及章末滚动留白、竖排每列避让底栏 | [透明度与遮挡修复验收](archived/reader-r1/INTERACTION_POLISH.md#2026-10-15-工具栏背景透明度) |
| 阅读滚动交互 | 已提交、工程与浏览器验收通过 | 正文外留白可滚动、竖排手势轴统一；阅读键平滑滚动并遵循减少动态效果偏好，位置恢复保持即时 | [滚动与切章提交复核](archived/reader-r1/INTERACTION_POLISH.md#2026-10-17-滚动与相邻切章提交前复核) |
| 跳转链与继续阅读 | 已提交、工程验收通过 | 连续查阅保留首次原点，持续阅读后下一次跳转更新原点；旧返回入口保留，失败请求不消耗阅读信号 | [跳转链验收](archived/reader-r1/INTERACTION_POLISH.md#2026-10-16-跳转链与继续阅读) |
| 章节位置记忆 | 已提交、工程与浏览器验收通过 | 各章最后位置持久化、目录恢复、当前章不跳与回到章首；保留恢复锚点，内容末端进入可读区域即 100%、回看可下降；图文混排按图片前正文显示进度，空白尾片段不阻断采样 | [章节位置验收](archived/epub-reading/CHAPTER_MEMORY_ACCEPTANCE.md)、[章末进度与真实书复核](archived/epub-reading/CHAPTER_MEMORY_ACCEPTANCE.md#2026-10-16-真实书复核与口径调整)、[提交前复核](archived/epub-reading/CHAPTER_MEMORY_ACCEPTANCE.md#2026-10-16-提交前复核) |
| 底部相邻章节导航 | 已提交、工程与浏览器验收通过 | 上一章／目录／下一章、首末边界与加载锁；复用章节记忆和返回链，保留工具面板与查询；窄屏进度移到顶部；章末入口未增加 | [相邻切章验收](archived/reader-r1/INTERACTION_POLISH.md#2026-10-16-底部相邻章节导航)、[提交复核](archived/reader-r1/INTERACTION_POLISH.md#2026-10-17-滚动与相邻切章提交前复核) |
| 阅读跳转协调 | 已提交，工程与浏览器验收通过 | 导航意图、目标校验、原点与相邻锁集中到同一 module；请求与正文呈现分别隔离迟到结果，返回提示显示原点章节与章内进度 | [本轮验收](archived/READER_NAVIGATION_REFACTOR_ACCEPTANCE.md) |
| 全量注音 | 已提交、工程验收通过 | 导入完整分词后可读，旧书补算，持久代次／失败保留／幂等重建；原书／全量与展示／按需／隐藏两维设置，原书 ruby 优先；位置与原生选区恢复通过提交前回归 | [全量注音验收](archived/full-ruby/ACCEPTANCE.md) |
| 阅读器正文复制 | 已提交，工程与实际复制粘贴验证通过 | 从当前正文投影提取所选字符，去除原书与自动注音，保留换行；纯文本复制不改变选区或注音显示 | [复制验收](text-study/READER_COPY_ACCEPTANCE.md) |
| EPUB 学习衔接 | C1／C2、阅读体验调整及保存表单优化已提交，工程与浏览器验收通过 | 原生选区保存与完整回读；自动语境保守整理后计预算，只读出处显示当前材料及逻辑章位置；正文细线、真实留白页边入口与固定完整本章列表，两项显示偏好独立；保存表单支持双侧清空与显式重新摘录；材料对话和 Occurrence 继续后置 | [C1 验收](text-study/C1_ACCEPTANCE.md)、[C2 验收](text-study/C2_ACCEPTANCE.md)、[原阅读标记验收](text-study/READER_MARKS_ACCEPTANCE.md)、[阅读体验记录](text-study/READING_EXPERIENCE_ACCEPTANCE.md)、[保存表单验收](text-study/SEGMENT_SAVE_FORM_ACCEPTANCE.md) |
| 阅读器原处预览 | 已提交，工程、联合浏览器验收及独立复核通过 | 单击可见标记直接紧凑回看，多片段先选，读取已有译文及多篇讲解；完整侧栏返回预览保留选择与手动位置；操作行前置，保存信息在底部折叠；页边入口随原文同步滚动，再次点击同一入口收起，原生划选保留 | [原处预览验收](text-study/INLINE_PREVIEW_ACCEPTANCE.md) |
| 文本分析与书籍统计 | 工程与浏览器验收通过 | 普通文本输入、完整分析资产读取与 EPUB 章节适配分开；详情独立展示词次／词种／汉字及覆盖曲线，有界缓存且不触发阅读打开或分词准备 | [B1 验收](text-study/B1_ACCEPTANCE.md)、[B2 验收](text-study/B2_ACCEPTANCE.md) |
| 学习条目与积累库 | 未实现 | 尚无 Occurrence 持久化、候选工具、整理操作或积累库页面；生产字段、定位、anchor 与恢复契约待落实 | [PRD F5／F6](../PRD.md#f5-学习条目创建与整理)、[A0 实验](../../references/occurrence_anchor_pilot/batch-01/report.md) |

**当前限制：** 接入类型为普通可重排 EPUB；封面缓存支持有界静态 PNG／JPEG。原书 ruby 控制使用书中已有注音。2026-10-04 切片 1 用户试读确认 Yomitan 配合正常；R1.1 的扩展、实体触屏、Safari／Firefox 等验证缺口见[工程验收](archived/reader-r1/ACCEPTANCE.md#明确未验证与限制)。

**实现占位：** Analysis 删除影响响应的 `occurrence_count` 默认为 `0`，服务尚未查询条目引用。字段与实现见[响应模型](../../backend/src/app/analysis_schemas.py)和[讲解服务](../../backend/src/app/services/analyses.py)。

### 阶段验收记录

下表提供原始证据入口。各记录维护当时的代码与环境、检查结果、浏览器观察和未验证项。

| 日期与阶段 | 验收记录 |
| --- | --- |
| 2026-10-03 架构重构 | [架构重构](archived/ARCHITECTURE_REFACTOR_ACCEPTANCE.md) |
| 2026-10-04 前端调整 | [前端调整](archived/frontend-refresh/ACCEPTANCE.md) |
| 2026-10-05 素材库 A.1 | [素材库 A.1](archived/library-a1/ACCEPTANCE.md) |
| 2026-10-05 来源空间 S2 | [S2 工程验收](archived/sources-s2/ACCEPTANCE.md) |
| 2026-10-05 阅读器 R1.1 | [R1.1 工程验收](archived/reader-r1/ACCEPTANCE.md) |
| 2026-10-06 阅读交互优化与提交隔离检查 | [交互优化](archived/reader-r1/INTERACTION_POLISH.md) |
| 2026-10-07 来源空间 S2 提交前复核 | [审计与复测](archived/sources-s2/ACCEPTANCE.md#2026-10-07-提交前复核) |
| 2026-10-10 阅读恢复、注音偏好与来源导航重构 | [工程、浏览器与用户复测](archived/READER_STATE_REFACTOR_ACCEPTANCE.md) |
| 2026-10-11 章节位置记忆 | [工程与浏览器验收](archived/epub-reading/CHAPTER_MEMORY_ACCEPTANCE.md) |
| 2026-10-13 章节位置记忆提交前复核 | [独立审查与章首边界复测](archived/epub-reading/CHAPTER_MEMORY_ACCEPTANCE.md#2026-10-13-提交前复核) |
| 2026-10-15 设置顶部分类 | [工程、独立审查与浏览器验收](archived/settings-refresh/ACCEPTANCE.md) |
| 2026-10-17 阅读滚动与相邻切章 | [提交前复核](archived/reader-r1/INTERACTION_POLISH.md#2026-10-17-滚动与相邻切章提交前复核) |
| 2026-10-19 书籍管理 | [工程、审查与浏览器验收](archived/book-management/ACCEPTANCE.md) |
| 2026-10-20 独立讲解回看与人工保存 | [A1 独立回看](text-study/A1_ACCEPTANCE.md)、[A2 人工资料与增量保护](text-study/A2_ACCEPTANCE.md) |
| 2026-10-20 开发期迁移基线整理 | [建库、业务回归与测试库数据保留验收](archived/DATABASE_BASELINE_ACCEPTANCE.md) |
| 2026-10-22 阅读体验调整 | [自动语境、只读出处与正文外片段入口](text-study/READING_EXPERIENCE_ACCEPTANCE.md) |
| 2026-10-23 阅读器原处预览 | [紧凑浮卡、展开侧栏和原生选择](text-study/INLINE_PREVIEW_ACCEPTANCE.md) |
| 2026-10-22 保存表单优化 | [语境预览、主题、清空与显式摘录](text-study/SEGMENT_SAVE_FORM_ACCEPTANCE.md) |

测试质量整改已完成并提交：凭据脱敏与落库回归、真实后台调度、编译产物校验，以及独立浏览器组件回归；工程检查与独立复审通过，证据及验证缺口见[测试质量验收](TEST_QUALITY_ACCEPTANCE.md)。

测试数量、包体积与提交隔离检查范围在原记录中维护；离线、真实模型与扩展验证各自对应其方法和观察。

当前界面约定见[阅读与导航](../INFORMATION_ARCHITECTURE.md)，执行机制与迁移链见[架构](../ARCHITECTURE.md)，旧库及旧备份的处理边界见 [升级与备份指南](../UPGRADING.md#旧开发数据库与备份)。阶段记录中的旧迁移编号、回填和数据保留结论继续作为历史事实保留。

## 2. 尚未落实的契约与目标差额

以下汇总尚未落实的契约。2026-10-20 已批准[文本处理与学习资料实施计划](text-study/PLAN.md)，S0 与 A／B 线已完成对应验收，A 线工程与浏览器验收均通过。2026-10-22 用户启动 C1 → C2，已先验收 C1，并在 C2 精确样例独立审查后完成实现与验收。人工资料入口与共同原文保护已实现。EPUB 学习衔接按更新后的阶段安排推进，Occurrence 与积累库保留首轮目标。

| 缺口 | 负责规范 | 实施前需要明确或补齐的内容 |
| --- | --- | --- |
| EPUB 学习衔接 | [PRD 4.7](../PRD.md#47-当前-epub-阶段安排)、[阶段安排](epub-reading/README.md) | C1／C2 已落实选区目标、可配置语境预装与精确返回；材料线程、引用、权限与费用，以及从讨论整理讲解的目标及部分成功反馈继续在对应切片收口 |
| Occurrence 生产契约 | [术语与知识表示](../GLOSSARY.md#4-知识表示与提取边界已对齐)、[PRD F5](../PRD.md#f5-学习条目创建与整理)、`TBD-02/03` | 带版本的字段与语义、类型边界、不连续 Surface／重复文字定位、anchor 规则和多个 Section 的确切引用；A0 不作为生产定案 |
| 条目读取与候选写入 | [PRD F5](../PRD.md#f5-学习条目创建与整理)、[F9](../PRD.md#f9-agent-工具权限与审核)、[架构 4.4–4.5](../ARCHITECTURE.md#44-可选批量提取未来模块servicesextractionpy尚不存在) | 将已确认读取、候选创建／修改及用户整理边界落实为 API、工具和执行校验；不能从 Analysis 工具签名推断候选协议 |
| 组合操作与恢复 | [PRD F8](../PRD.md#f8-状态与诊断)、`TBD-16/17`、[架构执行契约](../ARCHITECTURE.md#45-讨论与成果保存analysis已实现occurrence待设计) | Occurrence 的逐项结果、幂等身份、保存核实、局部修复与统一预算协调，以及混合方案的审核呈现；Analysis 已落实部分沿用现有机制 |
| 积累阅读与删除关联 | [PRD F6](../PRD.md#f6-知识库)、[F2](../PRD.md#f2-source-与片段)、[阅读基线](../GLOSSARY.md#5-阅读再理解与主动学习阅读基线已确认) | 条目列表、筛选／搜索、anchor 分组、原句和确切来源 Section 阅读；接上真实删除影响与引用范围 |

讨论不依赖已有 Analysis，保存讲解不依赖条目收录；创建条目则依赖持久、自足讲解和确切原文定位，见 [PRD 4.3](../PRD.md#43-语境与学习条目边界)。当前按 [PRD 4.7](../PRD.md#47-当前-epub-阶段安排)先推进 EPUB；已有手动片段学习继续独立使用，KnowledgePoint 归属与主动学习仍不在本阶段范围。

## 3. 验收与交接

- 选定实施任务后，将对应用户行为连通前端、API 与持久化。产品验收依据为 [PRD 第 8 节](../PRD.md#8-成功标准)，技术覆盖见 [架构第 8 节](../ARCHITECTURE.md#8-测试策略)，工程检查、迁移、API 生成和浏览器要求遵循 [AGENTS](../../AGENTS.md)。
- Occurrence 落地时补齐原文定位与历史引用、跨片段隔离、用户整理后的状态竞争、软删除／迟到结果、再次整理和部分成功恢复的验证；这些是现有目标的验收缺口，非新增规则。
- 离线样本须标明 fixture／模拟结果并保留来源，不冒充真实 API 录制。机械校验、真实模型接入、教学内容质量及实际学习体验分别记录；测试仍禁止真实网络与模型调用。
- 切片完成后把具体实现和决定写回负责文档，任务及验收记录移入归档，在[交接索引](README.md)保留证据与限制，并更新本文件的现状差额。实验、旧任务书和架构占位不能自行补全未决决定。
