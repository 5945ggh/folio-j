# 第一轮 MVP 实施基线

> 状态核对：2026-10-31；本轮材料词汇与统计自动更新以 `main 6c901c0` 为实施起点，工程、完整及词汇专项浏览器与独立审查已通过；验证范围见[材料词汇验收](reading-practice/VOCABULARY_ACCEPTANCE.md)。既有能力、验收与限制见下表。
> 本文件汇总当前能力、实现缺口和验收入口。产品范围见 [PRD](../PRD.md)，领域含义见 [GLOSSARY](../GLOSSARY.md)，技术选型见 [TECH_STACK](../TECH_STACK.md)；具体实现由[架构](../ARCHITECTURE.md)维护。

当前能力与缺口见下表，后续顺序与准备条件由[EPUB 阶段入口](epub-reading/README.md)维护；提交过程、检查数字及浏览器观察从对应验收记录查找。

2026-10-29 实际阅读评测补充：带上下文复制首版 `d125fee` 与数据库持久化调整 `14fb998` 已合入本地 main，现用库经一致性备份后升级至 `0002_context_copy_settings`，原有数据与凭据保持。首版浏览器与折叠调整的验证范围见[原验收](reading-practice/CONTEXT_COPY_ACCEPTANCE.md)；数据库调整通过常规工程检查及独立审查，实际升级与校验见[数据库验收](reading-practice/CONTEXT_COPY_DATABASE_ACCEPTANCE.md#现用库升级与主分支集成)，按用户要求未重跑浏览器。当时的后续顺序见[三阶段计划](reading-practice/PLAN.md)，当前交付见下方整合记录。

2026-10-30 本地整合：阅读设置 `eaee221` 与位置书签 `11ab6bb` 已合入原目录的本地 main。保留四组设置、会话草稿与离开保护，并接入单角圆角书签卡片及 `0003_material_bookmarks`。整合后的检查与启动核验见[集成记录](reading-practice/BOOKMARKS_ACCEPTANCE.md#2026-10-30-原目录集成)，现用库及原有凭据沿用已验证的升级结果。

2026-10-30 阅读翻译反馈修复：展开动画、共享缓存预算与按出处删除已合入本地 main，工程检查及 110 场浏览器回归分批通过。现用库备份后升至 `0004_translation_reader_removal`，原有 30 张业务表的数据与凭据一致；开发服务已恢复。实现、测量边界和交付记录见[本轮验收](reading-practice/TRANSLATION_RELIABILITY_ACCEPTANCE.md)。

## 1. 当前实现、差额与验收依据

| 能力 | 状态 | 当前能力与边界 | 验收依据 |
| --- | --- | --- | --- |
| 片段目录出处与删除 | 已合入本地 main，工程、定向浏览器及独立审查通过 | 概览／列表统一具体出处与时间，列表和详情共用删除确认及完整影响复核；讲解删除文字使用危险操作色；无数据库迁移 | [本轮验收](archived/SEGMENT_CATALOG_ACCEPTANCE.md) |
| 阅读器配色 token 收拢 | 已合入本地 main，工程与定向浏览器检查通过 | 保存提示保留紧凑布局并复用蓝色；工具、浮层、书签及图片查看器按语义归并原值，译文焦点和朗读滑块跟随 Reader 作用域；多套配色入口尚未实现 | [本轮验收](reading-practice/READER_COLOR_TOKENS_ACCEPTANCE.md)、[颜色约定](../DESIGN_SYSTEM.md#阅读器的强调色与标记) |
| 阅读翻译动画、共享缓存与删除 | 已合入本地 main，工程、浏览器与现用库核验通过 | 展开复用锚点并统一零态启动；Query 与图片共用 64 MiB／512 项估算保留预算，活跃工作集单列；按确切出处删除已有阅读历史和标记，停止重译，保留片段、讲解与关联快照；新增 0004 增量迁移 | [本轮验收](reading-practice/TRANSLATION_RELIABILITY_ACCEPTANCE.md)、[PRD 4.8](../PRD.md#48-阅读翻译与设备朗读) |
| 带上下文复制 | 已合入本地 main，现用库升级与只读配置核验通过 | 选区直接复制目标、语境及可选出处；复制默认值独立保存于数据库，旧浏览器值忽略；显式保存与冲突保稿，格式预览默认折叠；复用既有取文，不创建学习内容 | [首版验收](reading-practice/CONTEXT_COPY_ACCEPTANCE.md)、[数据库持久化验收](reading-practice/CONTEXT_COPY_DATABASE_ACCEPTANCE.md) |
| 阅读设置四组结构与会话草稿 | 已合入本地 main，整合回归通过 | 常用项直达，低频控件与说明折叠；摘要取已保存复制值，状态持续可见；排版、注音与界面分组恢复，复制只恢复草稿；同次阅读保稿及离开保护沿用各项存储范围，不新增迁移 | [现行交互](../INFORMATION_ARCHITECTURE.md#阅读设置分组与会话)、[结构依据](reading-practice/READER_SETTINGS_STRUCTURE.md)、[独立验收](reading-practice/READER_SETTINGS_ACCEPTANCE.md) |
| 位置书签 | 首版与交互改进已合入本地 main（2026-10-31），工程、浏览器与独立复核通过 | 附近提醒可仍然添加；单行成功摘要、限行卡片、章内进度、整卡详情与选中态、添加时间、快捷删除及独立跳转，共用删除确认；新摘要优先自然边界，旧摘要保持；删除书籍后保留并隐藏，不向重导材料换绑，本轮无数据库迁移 | [交互改进验收](reading-practice/BOOKMARK_REFINEMENT_ACCEPTANCE.md)、[首版验收](reading-practice/BOOKMARKS_ACCEPTANCE.md)、[PRD 4.9](../PRD.md#49-阅读摘录书签与记录检索) |
| 扩展书内搜索 | 已确认范围，未实现 | 后续搜索明确关联本书的片段、译文和书签；当前仍为原文字面检索 | [实施计划](reading-practice/PLAN.md) |
| 测试清理与入口回归 | 已提交，完整工程检查、浏览器矩阵及独立复审通过 | 清理旧分支与重复断言，保留业务保护；Reader 恢复默认、迟到注音与缓存回收通过真实入口回归，浏览器筛选空集明确失败 | [验收与变异检查](TEST_CLEANUP_ACCEPTANCE.md) |
| 来源与片段 | 已提交 | Source／Segment 手动录入、语境、编辑、逻辑删除与持久化；片段原文在首次 AI 任务受理、讲解成功保存或精确出处创建后锁定，共用原文保护规则 | [第一阶段](archived/STAGE_1_SOURCE_SEGMENT.md)、[2B](archived/STAGE_2B_ASYNC_QA.md)、[A2 验收](archived/text-study/A2_ACCEPTANCE.md)、[统一Agent验收](AGENT_CONTEXT_ACCEPTANCE.md) |
| 路由代码按需加载 | 已提交，主分支整合经工程检查、73 组完整浏览器回归及独立复核通过 | 默认素材库同步加载，其他页面按路由加载；阅读与片段路径共用稳定会话宿主，保留真实 URL、iframe 身份、精确返回与草稿；尾斜杠直达及地址切换有回归覆盖。原冷加载比较绑定当时版本，整合后未重测 | [路由加载验收与整合复核](archived/ROUTE_LOADING_ACCEPTANCE.md#主分支整合复核2026-10-27) |
| 数据库迁移基线 | 0001 至 0004 已合入，现用库升级完成 | `0001_schema_baseline` 保留原有 28 表；0002 新增复制设置表，0003 新增位置书签表，0004 新增阅读翻译删除字段；空库、旧数据保留、重复升级与回滚均有验证，现用库完整性、外键、原 30 表数据与凭据校验通过 | [架构](../ARCHITECTURE.md#3-领域模型)、[升级边界](../UPGRADING.md#当前迁移基线)、[基线历史验收](archived/DATABASE_MIGRATION_ACCEPTANCE.md)、[本轮升级验收](reading-practice/TRANSLATION_RELIABILITY_ACCEPTANCE.md#现用库与原目录交付) |
| 设置与模型接入 | 已提交、工程验收通过；模型设置二级切换用户已基本测试 | 学习背景、讲解预设、Provider／模型／用途默认值、模型发现及普通／流式文本验证；模型与服务分为默认模型与服务管理，保留分组保存、草稿保护和验证记录筛选 | [2A](archived/STAGE_2A_MODEL_SETTINGS.md)、[设置调整验收](archived/settings-refresh/ACCEPTANCE.md)、[二级切换验证](archived/SETTINGS_MODELS_ACCEPTANCE.md) |
| 阅读翻译与设备朗读 | 已提交，基础能力经全量浏览器验证；译文标题栏工具与选区拖动经工程、定向浏览器及只读复审通过 | 选区翻译、持久找回、原子采用、版本冲突保护；本章记录分片段／翻译，同出处成功译文归并标记、重叠入口合并，后台完成自动刷新；译文卡标题栏重译／停止、旧文保留与相邻版本回看，宽屏拖动、窄屏停靠；设备支持时可暂停／继续，结束后原条保留并切换重播，声音语速就地调整；真实模型质量与设备声音待实测，外部 TTS 后置 | [历史方案](archived/text-study/TRANSLATION_AND_SPEECH_PLAN.md)、[验收与限制](archived/text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md)、[标题栏与拖动验收](archived/text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md#选区译文标题栏工具与拖动2026-10-24)、[播放器联合验收](archived/text-study/SEGMENT_UI_ACCEPTANCE.md#提交前修复与联合验收2026-10-24) |
| 正文划选保存译文与临时定位高亮 | 已提交，工程、联合浏览器验收及独立复核通过 | 翻译详情移除新建及独立采用入口；正文草稿按确切位置及整体边缘空白规则匹配成功译文，一次预填并保护编辑／清空与冻结提交；原子创建采用收据；搜索及返回原处临时强调共用生命周期与淡出 | [联合验收与限制](archived/text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md#本章记录与学习片段联合验收2026-10-24)、[PRD 4.8](../PRD.md#48-阅读翻译与设备朗读) |
| 翻译会话状态归属 | 已提交 `8f6ce79`，工程、全量浏览器及独立复核通过 | 同目标双入口共用草稿和固定请求，历史选择分别保存；集中生成门禁、原请求核实与 Reader 生命周期；最近翻译视图及旧任务重做分支已移除 | [状态归属重构验收](archived/TRANSLATION_SESSION_REFACTOR_ACCEPTANCE.md)、[后续入口调整](archived/text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md#手动试用调整与注音调查2026-10-24) |
| 片段讨论 | 已提交上下文事件与统一Agent讲解；工程、定向浏览器及独立审查修复复核通过 | 持久线程、后台工具循环、冻结输入、停止、重启恢复与线程权限；上下文首轮完整提供、变化时追加模块完整值，保留旧注入；画像等模块独立版本化；材料出处派生字符串及状态随片段上下文冻结，材料变化后更新；普通要求写入消息正文，旧记录可恢复，审核反馈独立保留；「创建 AI 讲解」新建普通对话并明确请求创建保存独立讲解，普通提问默认不保存；读取工具覆盖当前 Segment 的讲解，聊天历史限于本线程 | [2B](archived/STAGE_2B_ASYNC_QA.md)、[2C](archived/STAGE_2C_ANALYSIS_TOOLS.md)、[界面调整验收](archived/text-study/SEGMENT_UI_ACCEPTANCE.md)、[上下文注入验收](AGENT_CONTEXT_ACCEPTANCE.md) |
| 持久讲解 | 已提交完整正文保存工具；工程、定向浏览器及独立复核通过 | 直接编写／粘贴 Markdown 保存，统一记录用户保存；当前全文修订、冲突保稿与同请求核实；多份 Analysis、不可变 Revision／Section；Agent完整提供Markdown后本地保存，取消内部写作分支；块编辑与审核沿用原规则 | [2C](archived/STAGE_2C_ANALYSIS_TOOLS.md)、[A2 验收](archived/text-study/A2_ACCEPTANCE.md)、[统一Agent验收](AGENT_CONTEXT_ACCEPTANCE.md) |
| 片段阅读与导航 | 已提交；内容聚合、浮层稳定性与讲解导航通过工程、浏览器及独立审查 | 窄工具栏／中央阅读／右侧讨论，进入隐藏全局导航；出处分书名／章名与定位入口，后台核对保持布局；原文／语境／当前译文及只读关联记录集中，朗读仅目标；完整资料浮层与讲解身份保留；纯回看不挂载讨论，激活后保活，窄屏切换保留草稿与阅读位置；确切修订、来处返回和人工编辑保护沿用原规则 | [阅读导航](archived/READING_NAVIGATION_ACCEPTANCE.md)、[架构重构](archived/ARCHITECTURE_REFACTOR_ACCEPTANCE.md)、[A1 验收](archived/text-study/A1_ACCEPTANCE.md)、[专注布局](archived/segment-layout/ACCEPTANCE.md)、[资料界面调整](archived/text-study/SEGMENT_UI_ACCEPTANCE.md)、[内容聚合验收](archived/text-study/SEGMENT_UI_ACCEPTANCE.md#片段内容聚合2026-10-24)、[讲解头部验收](archived/text-study/SEGMENT_UI_ACCEPTANCE.md#讲解标题与工具栏2026-10-24)、[创建与导航](archived/text-study/SEGMENT_UI_ACCEPTANCE.md#列表创建与文档导航2026-10-24) |
| 素材库与阅读管理 | 已提交；类型切换已通过工程检查及实际页面的显示、鼠标点击与键盘切换核对 | 跨 Source 书籍目录、搜索／筛选／排序／分页、书卡大小与状态菜单、空库整区导入；书籍为唯一可选类型，漫画、有声书和视频为禁用占位；阅读三态和最近打开持久化，封面按规则版本 2 回退与缓存 | [前端调整](archived/frontend-refresh/ACCEPTANCE.md)、[素材库 A.1](archived/library-a1/ACCEPTANCE.md) |
| 导入来源表单 | 已提交，工程检查通过；用户反馈无阻塞问题 | 添加书籍与新建来源完整视图切换，创建后自动选择来源并保留文件；单组操作、中文文案与表单提交保护 | [导入来源表单调整](archived/library-a1/ACCEPTANCE.md#2026-10-19-导入来源表单调整) |
| EPUB 导入书卡反馈 | 已提交，工程、完整离线浏览器及独立复审通过 | 提交立即关闭弹窗，当前标签页内以准备书卡承接导入；来源概览与书籍网格共享状态，成功提供入口且不抢导航，失败可重试或移除提示 | [验收与限制](archived/EPUB_IMPORT_FEEDBACK_ACCEPTANCE.md#2026-10-26-提交前-cr-修复) |
| 书籍管理 | 已提交，提交前工程、独立审查与浏览器复核通过；用户使用验收待进行 | 紧凑菜单与阅读状态二级入口、真实详情、书名与封面原子编辑／恢复、草稿／冲突保护及安全返回；公共默认外壳已统一并清理旧样式；移动仍禁用，不替换 EPUB；独立删除见下行 | [现行契约](../ARCHITECTURE.md#311-目录与材料使用状态)、[验收记录](archived/book-management/ACCEPTANCE.md) |
| 材料独立删除 | 已提交，工程、独立审查与浏览器验收通过 | 素材库与来源书卡删除材料并清空托管原书与派生阅读数据，保留材料身份、Source、片段、讲解、讨论及其他材料；完整访问门禁、幂等删除、目录计数与缓存隔离；重导创建新身份，移动与一并删除继续后置 | [产品规则](../PRD.md#421-本轮材料目录与阅读管理)、[验收记录](archived/MATERIAL_DELETION_ACCEPTANCE.md) |
| EPUB 编译包存储与编译器 | 已提交，工程、完整离线浏览器、真实导入阅读与独立审查通过 | 完整资源 HTML 仅为编译临时态；最终资源保留正文、样式及定位，章节 HTML 与原图按 v2 图片池格式保存；无旧格式读取、回退或转换工具；有界编译及展开预算保留，原 EPUB 与历史备份保留 | [格式与不变式](../ARCHITECTURE.md#31-实体)、[开发库边界](../UPGRADING.md#epub-存储格式与开发库重建)、[验收与测量](archived/EPUB_STORAGE_ACCEPTANCE.md) |
| 来源空间 S2 | 已提交 | 三栏及概览／素材／片段／讲解四视图、有界概览、来源分页、确切修订直达、视图／窗口／来处恢复；来源栏可调宽并保存偏好，片段／讲解列表搜索、排序与空态已打磨；工程验收完成，用户使用验收待进行 | [S2 工程验收](archived/sources-s2/ACCEPTANCE.md) |
| EPUB 导入与恢复 | 已提交 | 来源下导入、原书与不可变编译包托管、同源同字节复用、目录组章与连续图文、横竖排／字号／行距、持久位置与重排恢复；Source 删除后材料不可读，托管字节暂保留 | [切片 1](archived/epub-reading/SLICE_1_ACCEPTANCE.md)、[定位试验](archived/epub-reading/SLICE_0_ACCEPTANCE.md) |
| 阅读器 R1.1 | 已提交 | 独立阅读空间、专注／主题／字体／宽度／原书 ruby、书内字面搜索、插图库／大图和会话跳转原点；左右工具面板独立，保留正文交互及关闭层级 | [R1.1 工程验收](archived/reader-r1/ACCEPTANCE.md)、[交互优化](archived/reader-r1/INTERACTION_POLISH.md) |
| 独立图片查看器 | 已提交，工程、完整离线浏览器回归与独立复审通过 | 正文与图库共用查看器，按入口返回；居中图片与虚化背景、缩放拖动、复制图片、原图下载及在图库中查看当前出现项；真实触屏和系统剪贴板未验 | [验收与提交前修复](archived/epub-reading/IMAGE_VIEWER_PERFORMANCE_ACCEPTANCE.md#提交前-cr-修复2026-10-27)、[交互契约](../INFORMATION_ARCHITECTURE.md#书内搜索与图库)、[使用指南](../USAGE.md#查看正文图片与插图库) |
| 图片加载与定位优化 | 已提交，缓存竞争修复、完整离线浏览器回归与独立复审通过 | 正文图先显示，后台按出现身份定位；阅读会话有界复用元数据与图片字节 | [测量与验证](archived/epub-reading/IMAGE_VIEWER_PERFORMANCE_ACCEPTANCE.md) |
| 阅读会话复用 | 已提交，工程、完整浏览器及后续定向回归通过 | 同标签页片段往返复用最近一本书的正文与 iframe，返回重新核验并刷新学习状态；暂离十分钟或离开适用范围释放，仍按片段精确出处定位；测量未显示离线可读时间稳定下降 | [测量与验收](archived/text-study/READER_SESSION_ACCEPTANCE.md)、[宿主调整](archived/text-study/READER_SESSION_ACCEPTANCE.md#2026-10-25-阅读会话宿主局部调整) |
| 阅读页进入效果 | 已提交，工程、完整浏览器及实际页面检查通过；动画手感待用户试用 | 保留书卡按压，真实正文轻淡入、标题轻位移，加载提示延迟显示；不改变会话租期与恢复核验 | [试用记录](archived/text-study/READER_SESSION_ACCEPTANCE.md#2026-10-25-阅读页进入动画试用) |
| 阅读器既有主题适配 | 已提交，工程、全量浏览器及独立审查通过 | Reader 独立白／黑纸面；确认框、作者样式覆盖、讲解预览、错误提示、目录选中进度及辅助文字可读性 | [既有验收](archived/READER_THEME_ACCEPTANCE.md) |
| 整站基础颜色模式 | 已提交，工程、完整浏览器及独立审查通过 | 保留浅色视觉，应用浅／深／跟随系统、即时本地保存与跨标签同步；公共语义颜色与阅读器独立纸面，配色更新不重建正文或清空选区 | [整站主题验收](archived/APPLICATION_THEME_ACCEPTANCE.md)、[设计系统](../DESIGN_SYSTEM.md) |
| 阅读工具栏不透明度 | 已提交；不透明度语义与设置分组已统一，工程与完整离线浏览器回归通过 | 上下栏统一不透明度、轻微模糊、跨书偏好与恢复默认；兼容旧透明度值；横排顶部透文及章末滚动留白、竖排每列避让底栏 | [原透明度与遮挡验收](archived/reader-r1/INTERACTION_POLISH.md#2026-10-15-工具栏背景透明度)、[本轮修复验收](archived/epub-reading/IMAGE_VIEWER_PERFORMANCE_ACCEPTANCE.md#提交前-cr-修复2026-10-27) |
| 阅读滚动交互 | 已提交、工程与浏览器验收通过 | 正文外留白可滚动、竖排手势轴统一；阅读键平滑滚动并遵循减少动态效果偏好，位置恢复保持即时 | [滚动与切章提交复核](archived/reader-r1/INTERACTION_POLISH.md#2026-10-17-滚动与相邻切章提交前复核) |
| 阅读方向切换修复 | 已提交，工程、完整浏览器回归、指定章节副本验证及独立复审通过 | 清除旧页边标记保留的非阅读轴偏移，横竖切换保持正文和锚点可见 | [复现与验证](READER_LAYOUT_SWITCH_ACCEPTANCE.md) |
| 跳转链与继续阅读 | 已提交、工程验收通过 | 连续查阅保留首次原点，持续阅读后下一次跳转更新原点；旧返回入口保留，失败请求不消耗阅读信号 | [跳转链验收](archived/reader-r1/INTERACTION_POLISH.md#2026-10-16-跳转链与继续阅读) |
| 章节位置记忆 | 已提交、工程与浏览器验收通过 | 各章最后位置持久化、目录恢复、当前章不跳与回到章首；保留恢复锚点，内容末端进入可读区域即 100%、回看可下降；图文混排按图片前正文显示进度，空白尾片段不阻断采样 | [章节位置验收](archived/epub-reading/CHAPTER_MEMORY_ACCEPTANCE.md)、[章末进度与真实书复核](archived/epub-reading/CHAPTER_MEMORY_ACCEPTANCE.md#2026-10-16-真实书复核与口径调整)、[提交前复核](archived/epub-reading/CHAPTER_MEMORY_ACCEPTANCE.md#2026-10-16-提交前复核) |
| 底部相邻章节导航 | 已提交、工程与浏览器验收通过 | 上一章／目录／下一章、首末边界与加载锁；复用章节记忆和返回链，保留工具面板与查询；窄屏进度移到顶部；章末入口未增加 | [相邻切章验收](archived/reader-r1/INTERACTION_POLISH.md#2026-10-16-底部相邻章节导航)、[提交复核](archived/reader-r1/INTERACTION_POLISH.md#2026-10-17-滚动与相邻切章提交前复核) |
| 阅读跳转协调 | 已提交，工程与浏览器验收通过 | 导航意图、目标校验、原点与相邻锁集中到同一 module；请求与正文呈现分别隔离迟到结果，返回提示显示原点章节与章内进度 | [本轮验收](archived/READER_NAVIGATION_REFACTOR_ACCEPTANCE.md) |
| Reader 呈现协调 | 已提交，工程、完整浏览器回归、实际页面及独立复审通过 | 已加载目标携带 Chapter／part；正文呈现、重排、代次与回执、暂离保存集中管理，保留未呈现目标与章首意图 | [实施与验收](READER_PRESENTATION_REFACTOR_ACCEPTANCE.md) |
| 全量注音 | 已提交、工程验收通过 | 导入完整分词后可读，旧书补算，持久代次／失败保留／幂等重建；原书／全量与展示／按需／隐藏两维设置，原书 ruby 优先；位置与原生选区恢复通过提交前回归 | [全量注音验收](archived/full-ruby/ACCEPTANCE.md) |
| 阅读器正文复制 | 已提交，工程与实际复制粘贴验证通过 | 从当前正文投影提取所选字符，去除原书与自动注音，保留换行；纯文本复制不改变选区或注音显示 | [复制验收](archived/text-study/READER_COPY_ACCEPTANCE.md) |
| EPUB 学习衔接 | C1／C2、阅读体验调整及保存表单优化已提交，工程与浏览器验收通过 | 原生选区保存与完整回读；自动语境保守整理后计预算，只读出处显示当前材料及逻辑章位置；正文细线、真实留白页边入口与固定完整本章列表，两项显示偏好独立；保存表单支持双侧清空与显式重新摘录；材料对话和 Occurrence 继续后置 | [C1 验收](archived/text-study/C1_ACCEPTANCE.md)、[C2 验收](archived/text-study/C2_ACCEPTANCE.md)、[原阅读标记验收](archived/text-study/READER_MARKS_ACCEPTANCE.md)、[阅读体验记录](archived/text-study/READING_EXPERIENCE_ACCEPTANCE.md)、[保存表单验收](archived/text-study/SEGMENT_SAVE_FORM_ACCEPTANCE.md) |
| 阅读器原处预览 | 已提交，工程、联合浏览器验收及独立复核通过 | 单击可见标记直接紧凑回看，多片段先选，读取已有译文及多篇讲解；完整侧栏返回预览保留选择与手动位置；操作行前置，保存信息在底部折叠；页边入口随原文同步滚动，再次点击同一入口收起，原生划选保留 | [原处预览验收](archived/text-study/INLINE_PREVIEW_ACCEPTANCE.md) |
| 文本分析与书籍统计 | 基础统计已提交，既有工程与浏览器验收通过 | 普通文本输入、完整分析资产读取与 EPUB 章节适配分开；详情独立展示词次／词种／汉字及覆盖曲线，有界缓存且不触发阅读打开或分词准备 | [B1 验收](archived/text-study/B1_ACCEPTANCE.md)、[B2 验收](archived/text-study/B2_ACCEPTANCE.md) |
| 材料词汇与统计自动更新 | 工程、完整及专项浏览器与独立审查通过 | 详情统计自动观察当前代次；独立词表支持词性、词频、词形／读音及出现位置，按确切版本／代次分页读取；原文核验后临时定位，返回保留条件；无词典释义、永久词条或迁移 | [本轮验收](reading-practice/VOCABULARY_ACCEPTANCE.md)、[页面契约](../INFORMATION_ARCHITECTURE.md#材料词汇页) |
| 学习条目与积累库 | 未实现 | 尚无 Occurrence 持久化、候选工具、整理操作或积累库页面；生产字段、定位、anchor 与恢复契约待落实 | [PRD F5／F6](../PRD.md#f5-学习条目创建与整理)、[A0 实验](../../references/occurrence_anchor_pilot/batch-01/report.md) |

**当前限制：** 接入类型为普通可重排 EPUB；封面缓存支持有界静态 PNG／JPEG。原书 ruby 控制使用书中已有注音。2026-10-04 切片 1 用户试读确认 Yomitan 配合正常；R1.1 的扩展、实体触屏、Safari／Firefox 等验证缺口见[工程验收](archived/reader-r1/ACCEPTANCE.md#明确未验证与限制)。

**设备待核实：** Chrome 中多种音色修改语速并从头重播后，用户听感仍无变化；目前仅验证参数传递，根因与实际变速效果未确认，见[调查记录](archived/text-study/SEGMENT_UI_ACCEPTANCE.md#chrome-语速问题调查)。

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
| 2026-10-20 独立讲解回看与人工保存 | [A1 独立回看](archived/text-study/A1_ACCEPTANCE.md)、[A2 人工资料与增量保护](archived/text-study/A2_ACCEPTANCE.md) |
| 2026-10-20 开发期迁移基线整理 | [建库、业务回归与测试库数据保留验收](archived/DATABASE_BASELINE_ACCEPTANCE.md) |
| 2026-10-22 阅读体验调整 | [自动语境、只读出处与正文外片段入口](archived/text-study/READING_EXPERIENCE_ACCEPTANCE.md) |
| 2026-10-22 保存表单优化 | [语境预览、主题、清空与显式摘录](archived/text-study/SEGMENT_SAVE_FORM_ACCEPTANCE.md) |
| 2026-10-23 阅读器原处预览 | [紧凑浮卡、展开侧栏和原生选择](archived/text-study/INLINE_PREVIEW_ACCEPTANCE.md) |
| 2026-10-23 阅读翻译与设备朗读 | [阅读辅助联合验收](archived/text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md#2026-10-23提交前审查修复与联合验收)、[翻译卡片与朗读控制](archived/text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md#2026-10-23-翻译卡片与朗读控制交互调整) |
| 2026-10-24 原处预览与阅读记录调整 | [段尾译文与浮窗](archived/text-study/INLINE_PREVIEW_ACCEPTANCE.md#段尾译文与可拖动记录浮窗2026-10-24)、[译文开合复核](archived/text-study/INLINE_PREVIEW_ACCEPTANCE.md#译文开合提交前复核2026-10-24)、[页边与定位](archived/text-study/INLINE_PREVIEW_ACCEPTANCE.md#页边点击入口定位与翻译卡片2026-10-24)、[记录列表与预览](archived/text-study/INLINE_PREVIEW_ACCEPTANCE.md#记录列表与学习片段预览调整2026-10-24) |
| 2026-10-24 翻译记录与保存入口调整 | [本章记录](archived/text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md#2026-10-24-本章记录与正文翻译标记)、[分批提交记录](archived/text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md#记录与保存调整分批提交2026-10-24)、[手动试用调整](archived/text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md#手动试用调整与注音调查2026-10-24) |
| 2026-10-24 片段对话与讲解操作 | [发送快捷键](archived/text-study/SEGMENT_UI_ACCEPTANCE.md#对话发送快捷键2026-10-24)、[重命名与图标联合验收](archived/text-study/SEGMENT_UI_ACCEPTANCE.md#三项交互提交前联合验收2026-10-24) |
| 2026-10-24 注音与竖排标记修复 | [自动注音词首假名](archived/text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md#自动注音词首假名修复2026-10-24)、[竖排旁线](archived/text-study/TRANSLATION_AND_SPEECH_ACCEPTANCE.md#竖排正文标记修复2026-10-24) |

EPUB 编译、聊天执行及历史渲染的后续修复见[CR 修复验收](archived/CR_FIXES_ACCEPTANCE.md)；阅读会话和导入反馈的证据已列在能力表中。

测试质量整改已完成并提交：凭据脱敏与落库回归、真实后台调度、编译产物校验，以及独立浏览器组件回归；工程检查与独立复审通过，证据及验证缺口见[测试质量验收](archived/TEST_QUALITY_ACCEPTANCE.md)。

测试数量、包体积与提交隔离检查范围在原记录中维护；离线、真实模型与扩展验证各自对应其方法和观察。

当前界面约定见[阅读与导航](../INFORMATION_ARCHITECTURE.md)，执行机制与迁移链见[架构](../ARCHITECTURE.md)，旧库及旧备份的处理边界见 [升级与备份指南](../UPGRADING.md#旧开发数据库与备份)。阶段记录中的旧迁移编号、回填和数据保留结论继续作为历史事实保留。

## 2. 尚未落实的契约与目标差额

以下汇总尚未落实的契约与目标差额。人工资料、文本统计及 C1／C2 精确出处的能力和证据见上表；切片依赖及实施依据见[文本处理与学习资料计划](archived/text-study/PLAN.md)。材料对话及从讨论形成讲解继续按 EPUB 阶段安排推进，Occurrence 与积累库保留首轮目标。

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
