# 第一轮 MVP 实施基线

> 状态核对：2026-10-08，已提交代码基准 `fedad61`。
> 产品范围以 [PRD.md](../PRD.md) 为准，领域含义以 [GLOSSARY.md](../GLOSSARY.md) 为准，技术方案以 [TECH_STACK.md](../TECH_STACK.md) 为准。
> 本文件汇总当前能力、实现缺口和阶段验收；产品规则链接至负责规范。

当前能力与缺口见下表，产品边界见 [PRD 4.7](../PRD.md#47-当前-epub-阶段安排)，后续顺序与准备条件由[EPUB 阶段入口](epub-reading/README.md)维护。

## 1. 当前实现、差额与验收依据

| 能力 | 状态 | 当前能力与边界 | 验收依据 |
| --- | --- | --- | --- |
| 来源与片段 | 已提交 | Source／Segment 手动录入、语境、编辑、逻辑删除与持久化；片段原文在首次 AI 任务被接受后锁定 | [第一阶段](archived/STAGE_1_SOURCE_SEGMENT.md)、[2B](archived/STAGE_2B_ASYNC_QA.md) |
| 设置与模型接入 | 已提交 | 学习背景、讲解预设、Provider／模型／用途默认值、模型发现及普通／流式文本验证 | [2A](archived/STAGE_2A_MODEL_SETTINGS.md) |
| 片段讨论 | 已提交 | 持久线程、后台工具循环、输入快照、停止、重启恢复与线程权限；读取工具覆盖当前 Segment 的讲解，聊天历史限于本线程 | [2B](archived/STAGE_2B_ASYNC_QA.md)、[2C](archived/STAGE_2C_ANALYSIS_TOOLS.md) |
| 持久讲解 | 已提交 | 多份 Analysis、不可变 Revision、Section／Preamble、总体讲解快捷生成、块级编辑与具体方案审核；整份删除由用户操作 | [2C](archived/STAGE_2C_ANALYSIS_TOOLS.md) |
| 片段阅读与导航 | 已提交 | 默认阅读、原文与讲解对照、确切修订／讨论定位、讲解总标题、本页讨论草稿保留；未提交草稿仅在当前挂载页面保留 | [阅读导航](archived/READING_NAVIGATION_ACCEPTANCE.md)、[架构重构](archived/ARCHITECTURE_REFACTOR_ACCEPTANCE.md) |
| 素材库与阅读管理 | 已提交 | 跨 Source 书籍目录、搜索／筛选／排序／分页、书卡大小与状态菜单、空库整区导入；阅读三态和最近打开持久化，封面按规则版本 2 回退与缓存 | [前端调整](frontend-refresh/ACCEPTANCE.md)、[素材库 A.1](library-a1/ACCEPTANCE.md) |
| 来源空间 S2 | 已提交 | 三栏及概览／素材／片段／讲解四视图、有界概览、来源分页、确切修订直达、视图／窗口／来处恢复；工程验收完成，用户使用验收待进行 | [S2 工程验收](sources-s2/ACCEPTANCE.md) |
| EPUB 导入与恢复 | 已提交 | 来源下导入、原书与不可变编译包托管、同源同字节复用、目录组章与连续图文、横竖排／字号／行距、持久位置与重排恢复；Source 删除后材料不可读，托管字节暂保留 | [切片 1](epub-reading/SLICE_1_ACCEPTANCE.md)、[定位试验](epub-reading/SLICE_0_ACCEPTANCE.md) |
| 阅读器 R1.1 | 已提交 | 独立阅读空间、专注／主题／字体／宽度／原书 ruby、书内字面搜索、插图库／大图和会话跳转原点；左右工具面板独立，保留正文交互及关闭层级 | [R1.1 工程验收](reader-r1/ACCEPTANCE.md)、[交互优化](reader-r1/INTERACTION_POLISH.md) |
| 全量注音 | 已提交、工程验收通过 | 导入完整分词后可读，旧书补算，持久代次／失败保留／幂等重建；原书／全量与展示／按需／隐藏两维设置，原书 ruby 优先；位置与原生选区恢复通过提交前回归 | [全量注音验收](full-ruby/ACCEPTANCE.md) |
| EPUB 学习衔接 | 未实现 | 选区创建或选用 Segment、材料对话与消息引用、从材料讨论形成讲解按后续切片推进 | [EPUB 阶段安排](epub-reading/README.md) |
| 学习条目与积累库 | 未实现 | 尚无 Occurrence 持久化、候选工具、整理操作或积累库页面；生产字段、定位、anchor 与恢复契约待落实 | [PRD F5／F6](../PRD.md#f5-学习条目创建与整理)、[A0 实验](../../references/occurrence_anchor_pilot/batch-01/report.md) |

**当前限制：** 接入类型为普通可重排 EPUB；封面缓存支持有界静态 PNG／JPEG。原书 ruby 控制使用书中已有注音。2026-10-04 切片 1 用户试读确认 Yomitan 配合正常；R1.1 的扩展、实体触屏、Safari／Firefox 等验证缺口见[工程验收](reader-r1/ACCEPTANCE.md#明确未验证与限制)。

**实现占位：** Analysis 删除影响响应的 `occurrence_count` 默认为 `0`，服务尚未查询条目引用。字段与实现见[响应模型](../../backend/src/app/analysis_schemas.py)和[讲解服务](../../backend/src/app/services/analyses.py)。

### 阶段验收记录

下表提供原始证据入口。各记录维护当时的代码与环境、检查结果、浏览器观察和未验证项。

| 日期与阶段 | 验收记录 |
| --- | --- |
| 2026-10-03 架构重构 | [架构重构](archived/ARCHITECTURE_REFACTOR_ACCEPTANCE.md) |
| 2026-10-04 前端调整 | [前端调整](frontend-refresh/ACCEPTANCE.md) |
| 2026-10-05 素材库 A.1 | [素材库 A.1](library-a1/ACCEPTANCE.md) |
| 2026-10-05 来源空间 S2 | [S2 工程验收](sources-s2/ACCEPTANCE.md) |
| 2026-10-05 阅读器 R1.1 | [R1.1 工程验收](reader-r1/ACCEPTANCE.md) |
| 2026-10-06 阅读交互优化与提交隔离检查 | [交互优化](reader-r1/INTERACTION_POLISH.md) |
| 2026-10-07 来源空间 S2 提交前复核 | [审计与复测](sources-s2/ACCEPTANCE.md#2026-10-07-提交前复核) |

测试数量、包体积与提交隔离检查范围在原记录中维护；离线、真实模型与扩展验证各自对应其方法和观察。

本次状态整理核对代码与已有验收记录。当前界面约定见[阅读与导航](../INFORMATION_ARCHITECTURE.md)，执行机制见[架构](../ARCHITECTURE.md)。

## 2. 尚未落实的契约与目标差额

以下汇总尚未落实的契约。EPUB 切片按阶段安排推进，Occurrence 与积累库保留首轮目标。

| 缺口 | 负责规范 | 实施前需要明确或补齐的内容 |
| --- | --- | --- |
| EPUB 学习衔接 | [PRD 4.7](../PRD.md#47-当前-epub-阶段安排)、[阶段安排](epub-reading/README.md) | 选区目标、语境和返回路径；材料线程、引用、权限与费用；从讨论整理讲解的目标及部分成功反馈 |
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
