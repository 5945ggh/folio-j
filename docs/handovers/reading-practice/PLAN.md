# 实际阅读评测：复制、书签与搜索

> 2026-10-29：根据持续使用中的需求确认范围，按三个独立目标依次实施。当前交付状态见 [MVP 实施基线](../MVP_IMPLEMENTATION_BASELINE.md)。

## 已确认方向

用户需要将选中的日语连同必要语境复制到外部 AI 对话，并主动留下以后回来阅读或处理的位置。普通阅读感想独立于学习片段和讲解；书签作为阅读器基础能力维护。产品行为由 [PRD 4.9](../../PRD.md#49-阅读摘录书签与记录检索)负责，领域定义见 [GLOSSARY](../../GLOSSARY.md)，页面安排见[阅读与导航](../../INFORMATION_ARCHITECTURE.md)。

## 后续实施

原定顺序为“带上下文复制 → 位置书签与备注 → 扩展书内搜索”。前两项目标及阅读设置、翻译反馈修复、材料词汇已完成，当前能力与验收入口见[实施基线](../MVP_IMPLEMENTATION_BASELINE.md)。阅读设置的现行分组和保存范围见[阅读设置交互](../../INFORMATION_ARCHITECTURE.md#阅读设置分组与会话)，调查依据见[结构方案](../archived/reading-practice/READER_SETTINGS_STRUCTURE.md)。

扩展书内搜索仍为后续独立目标：统一检索本书原文、学习片段、译文及书签备注。实施前明确各类资料与本书的关联、命中字段及结果打开方式；重复位置可聚合显示，但保留各条资料的身份。原文扫描与可变资料查询分别实现，复用既有精确定位、返回路径与删除门禁。材料词汇页不替代本项，也不据此引入词典释义或学习条目。

选定目标后使用独立短期分支，完成对应验证再推进下一项。复制模板编辑、多预设、精确范围批注、常驻高亮及书签独立归档查看继续按实际使用反馈独立评估。

## 阅读设置待评估事项

以下承接[结构调查](../archived/reading-practice/READER_SETTINGS_STRUCTURE.md)的独有线索，作为候选与决定前提保留，尚未承诺实施或迁移。

| 事项 | 现有线索与决定前提 |
| --- | --- |
| 缺省值来源 | Reader 首次使用与恢复默认的字号／行距为 22／2.0，后端 `ReadingSettings` 缺省为 20／1.8；先明确各自适用入口与默认值来源，再决定是否调整，结构归档不改变已有值 |
| 排版与阅读位置解耦 | 字号／行距／方向目前随阅读位置保存；先决定从哪份位置提取初值、新设置与历史恢复的优先关系，以及怎样保留当前位置 |
| 本书习惯跨浏览器 | 字体／注音等仍按当前浏览器的本书版本保存；若用户需要跨浏览器一致，先决定按材料还是版本归属、旧浏览器值与数据库值的冲突优先关系及设备例外 |
| 屏幕相关本地偏好 | 宽度、纸面、工具栏等与屏幕和使用环境相关；先确认是否需要跨书默认与逐书覆盖，再决定保存范围和继承关系 |

未来迁移仍须备份、增量升级并明确旧值优先关系；复制配置曾忽略旧浏览器值，不代表其他阅读偏好采用相同规则。

## 验证与数据保护

当前已有需要保留的日常使用数据。数据库变更采用增量迁移，验证使用独立合成库；升级实际使用库前按[升级与备份](../../UPGRADING.md)制作一致性备份并核对凭据配套。测试不调用真实网络或模型。

历史检查、浏览器观察及验证限制见[复制首版](../archived/reading-practice/CONTEXT_COPY_ACCEPTANCE.md)、[复制数据库持久化](../archived/reading-practice/CONTEXT_COPY_DATABASE_ACCEPTANCE.md)、[阅读设置](../archived/reading-practice/READER_SETTINGS_ACCEPTANCE.md)、[位置书签](../archived/reading-practice/BOOKMARKS_ACCEPTANCE.md)与[书签交互改进](../archived/reading-practice/BOOKMARK_REFINEMENT_ACCEPTANCE.md)；翻译修复与词汇页分别见[翻译验收](../archived/reading-practice/TRANSLATION_RELIABILITY_ACCEPTANCE.md)、[词汇验收](../archived/reading-practice/VOCABULARY_ACCEPTANCE.md)。

每阶段完成 `just lint`、`just test`、构建、文档检查与对应真实浏览器入口验证。新增逻辑覆盖行为和失败路径；回归按影响范围选择。浏览器证据区分模拟剪贴板、真实系统剪贴板及实体触屏设备。

实际使用反馈记录当时目标、现有绕行方式、复现条件与出现频率，据此调整默认参数和后续顺序。
