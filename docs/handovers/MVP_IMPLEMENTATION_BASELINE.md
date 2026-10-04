# 第一轮 MVP 实施基线

> 状态核对：2026-10-04，代码基准 `2214fc9`（含 EPUB 切片 1）。Source／Segment、设置、讨论、Analysis、阅读导航及 EPUB 基础阅读已有实现；Occurrence 与积累库尚未实现，首轮 MVP 尚未全部完成。
> 产品范围以 [PRD.md](../PRD.md) 为准，领域含义以 [GLOSSARY.md](../GLOSSARY.md) 为准，技术方案以 [TECH_STACK.md](../TECH_STACK.md) 为准。
> 本文件维护当前实现、首轮目标差额、尚未落实的技术契约和验收依据；产品规则按下文链接回到负责文档，不另立一份功能规格。

**当前阶段安排：** EPUB 切片 1 的正式导入与基础阅读已验收，用户确认当前阅读体验及 Yomitan 配合正常；后续先安排整体前端调整与全量注音两个独立切片，再推进选区学习。产品边界见 [PRD 4.7](../PRD.md#47-当前-epub-阶段安排)，顺序见[EPUB 阶段入口](epub-reading/README.md)。Occurrence 与积累库继续暂缓。

## 1. 当前实现、差额与验收依据

| 能力 | 当前实现 | 差额或限制 | 历史验收依据 |
| --- | --- | --- | --- |
| 来源与片段 | Source／Segment 手动录入、附带语境、编辑、逻辑删除与持久化 | 无素材文件接入；原文在首次 AI 任务被接受后锁定 | [第一阶段](archived/STAGE_1_SOURCE_SEGMENT.md) |
| 设置与模型接入 | 学习背景、讲解偏好、Provider／模型／用途默认值、列表发现与文本验证 | 配置或文本验证不证明所有模型能力和教学质量 | [2A](archived/STAGE_2A_MODEL_SETTINGS.md) |
| 片段讨论 | 持久线程、后台工具循环、输入快照、历史、停止、重启恢复与线程权限 | 当前资料工具仅覆盖 Analysis；不读取其他线程聊天历史或跨片段内容 | [2B](archived/STAGE_2B_ASYNC_QA.md)、[2C](archived/STAGE_2C_ANALYSIS_TOOLS.md)；2B 的单次调用机制已由 2C 扩展 |
| 持久讲解 | 多份 Analysis、不可变 Revision、Section／Preamble、总体讲解快捷入口、生成保存、块级编辑与具体操作审核、用户删除 | 不开放整份 Analysis 的 Agent 删除工具；Occurrence 引用尚无法接入 | [2C](archived/STAGE_2C_ANALYSIS_TOOLS.md) |
| 阅读与导航 | 普通入口默认阅读、原文与讲解对照、确切修订／讨论定位、独立讲解总标题、本页讨论草稿保留 | 刷新或离开页面不承诺恢复未提交草稿；构建有主 JS 包大于 500 kB 的历史提示 | [阅读导航验收](archived/READING_NAVIGATION_ACCEPTANCE.md)，已在 `219cd24` 提交 |
| 学习条目与积累库 | 尚无 Occurrence 持久化、候选工具、整理状态操作或积累库页面 | PRD F5／F6 保留后续目标，本 EPUB 阶段暂缓；字段、定位、anchor 与相关恢复契约未落实 | 只有 [A0 实验](../../references/occurrence_anchor_pilot/batch-01/report.md)，不等于生产实现或契约 |
| EPUB 原生阅读 | 来源下导入、原书托管、目录组章与连续图文、横竖排／字号／行距、持久阅读位置及重排恢复、Source 删除材料门禁；用户实测 Yomitan 配合正常 | 选区学习、材料对话及讨论形成讲解尚未接入；自动注音未实现，用户认可当前不做分页 | [切片 1 验收](epub-reading/SLICE_1_ACCEPTANCE.md)、[定位试验](epub-reading/SLICE_0_ACCEPTANCE.md) |

**实现占位：** Analysis 删除影响响应的 `occurrence_count` 当前默认 `0`，服务未查询 Occurrence 引用；不能据此声称已提供学习条目引用计数。实现依据见 [响应模型](../../backend/src/app/analysis_schemas.py)与[讲解服务](../../backend/src/app/services/analyses.py)。

**证据口径：** 上表链接保存各阶段当时通过的检查、浏览器观察及其限制。阅读导航记录包含离线测试和模拟模型的浏览器验收，不证明真实模型教学质量、实际缓存命中或长期学习效果。文档整理核对代码与记录，不代表重新进行了浏览器或真实模型验收。

2026-10-03 完成的[架构重构验收](archived/ARCHITECTURE_REFACTOR_ACCEPTANCE.md)补充统一编辑规则、讨论状态推进与旧 Job 死代码清理的证据：后端 183 项、前端 29 项测试及离线浏览器验收通过，未扩大上表产品能力或 Occurrence 契约。

“已确认”说明产品决定，“已有实现”说明代码状态；表中未实现项不因此退出首轮目标，也不自动确定后续排期。当前界面约定见 [阅读与导航](../INFORMATION_ARCHITECTURE.md)，当前执行机制见 [架构](../ARCHITECTURE.md)。

## 2. 尚未落实的契约与目标差额

以下记录实现缺口及其依据，不选择下一切片或编排交付顺序。已有 Analysis 的身份、规范化、工具审核与恢复机制不重复列为待开发。

| 缺口 | 负责规范 | 实施前需要明确或补齐的内容 |
| --- | --- | --- |
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
