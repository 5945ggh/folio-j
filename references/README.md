# 研究材料索引

这些材料保留了早期日语解析、Occurrence 定位与阅读呈现的可追溯证据，供实现与复核时参考。它们是实验记录；格式、字段、A0 anchor 规则和静态页面交互均不构成当前产品契约。实现以 [`docs/PRD.md`](../docs/PRD.md)、[`docs/GLOSSARY.md`](../docs/GLOSSARY.md) 和 [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) 为准。

| 类别 | 入口 | 材料性质与保留理由 |
| --- | --- | --- |
| 基础概念提案 | [基础概念草案 v0.1](Folio-J_基础概念草案_v0.1.md) | 2026-10-17 的知识对象、学习者模型与教学交互设计提案，供讨论与案例验证；其中的实体、字段和能力判断不代表生产模型或开发排期。 |
| 阅读辅助样例 | [说明](folio-reading-aids-v0.1/README.md)、[实施建议](folio-reading-aids-v0.1/DESIGN.md)与[独立交互样例](folio-reading-aids-v0.1/prototype.html) | 基于 2026-10-19 快照的翻译、朗读与讲解交互探索；样例仅在内存演示，译文预置、音频模拟。部分方向已有后续实现，当前操作与范围见[使用指南](../docs/USAGE.md)和[实施基线](../docs/handovers/MVP_IMPLEMENTATION_BASELINE.md)。 |
| 原句 | [句子语料](sentence_examples/README.md) | 真实素材节选与来源提示；为解析和定位提供原文依据，不将索引当成原文。 |
| 解析风格 | [初步解析示例](first_step_analysis_examples/README.md) | 输入 `source.md`、历史 prompt 模板和模型原始 Markdown／JSON 输出并存；可比较讲解风格与输出形状，JSON 实验格式不是生产 schema。 |
| anchor 实验 | [batch-01 报告](occurrence_anchor_pilot/batch-01/report.md) | 六份输入及解析快照、[清单](occurrence_anchor_pilot/batch-01/manifest.json)、35 条试提取记录、人工复核与[机械校验](occurrence_anchor_pilot/batch-01/validate.py)；A0 是当时的试验基线，不是已批准的 anchor 规则。 |
| 阅读实验 | [阅读视图说明](occurrence_anchor_pilot/reading-experiment/README.md)与[报告](occurrence_anchor_pilot/reading-experiment/report.md) | 从 batch-01 选取四例，对照简释、原 Section 和 JSON 树；`data.json` 是由快照确定性派生的演示数据，保留以便复现与比较。 |

`batch-01/manifest.json` 同时记录原研究目录的历史绝对路径和本仓库内的相对快照路径；复核应使用随仓库保存的 `snapshots/` 与 SHA-256，而不依赖原个人目录。`occurrences.jsonl` 是人工试提取结果，`validation.json` 是 `validate.py` 的派生输出；机械通过不等于教学判断正确。阅读实验的 `build.mjs` 可重建 `data.json`，`parser-test.mjs` 验证转换；所用 Marked 的许可文本保存在 `vendor/LICENSE.md`。原句及解析素材未附再授权许可，不据此推定额外使用权。

原句素材和各实验快照可能覆盖相邻或相同文本，仍分别保留：前者提供素材索引，后者锁定当时使用的输入与讲解，支持散列、行号和定位结果复核。历史 prompt 与输出也同时保留，用于区分输入约束、模型产物和后来确定性转换。
