# 全链路提示词聚合审阅草案

> 2026-09-27。**候选文案，尚未接入、未通过真实模型或工具协议验证。** 下文工具名是概念签名，不是已交付 schema。生产 prompt 应放在 `backend/prompts/`，文件头声明版本，修改时递增版本。产品边界见[2C开工准备](STAGE_2C_ANALYSIS_TOOLS.md)、[PRD](../PRD.md)、[术语表](../GLOSSARY.md)、[架构](../ARCHITECTURE.md)。

## 1. 当前实际运行的 2B 问答

`services/context.py` 在接受问答时冻结输入快照，依次组装：

1. `system`：[chat/system_v2.j2](../../backend/prompts/chat/system_v2.j2)，版本 v2。按本轮意图区分普通讨论、专题讲解和总体报告；仍写着“当前没有创建、修改或删除 Analysis／Occurrence 的工具”。
2. 同线程此前**成功**轮次的完整 user／assistant 消息。失败或中断残文不自动进入下一轮。
3. `user`：[chat/user_v1.j2](../../backend/prompts/chat/user_v1.j2)，版本 v1。提供 Source、目标 Segment、用户给的前后文／译文／听写、出处、本轮问题与补充要求。

学习背景与选定讲解预设插入 system。首次初始化的默认讲解来自[default_explanation_style_v1.j2](../../backend/prompts/default_explanation_style_v1.j2)；之后读取数据库中实际选定的 `Style.body_md`，升级模板不覆盖已保存的用户预设。预设调整语言、细度和重点；其报告组织命令仅在本轮要求相应文档时适用。当前组合 `prompt_version=v2`，确切渲染消息随 Job／Run 保存。[system_v1.j2](../../backend/prompts/chat/system_v1.j2)是旧版本，不参与新问答。

[总体讲解示例 v0.1](../../references/first_step_analysis_examples/v0.1/prompt-template.md)是教学组织参考，不是运行时 system；其中“中文／初级／已会五十音”等个人背景不应硬编码给所有用户。

## 2. 未来调用的组装顺序

| 调用 | 上下文与加载条件 | 专用内容及结果 |
| --- | --- | --- |
| 主对话每轮 | 主 Agent system；接受时冻结的 Source／Segment、背景、预设、本轮请求、本线程成功历史；共享资料按需读取 | 正常答复或实际工具结果；普通问答无成果写入 |
| 新建 Analysis 分支 | **触发点的主对话完整上下文快照**：讨论语义、用户要求、已读取资料及出处；快捷入口无历史时用本次 Segment 与总体讲解请求 | 换用下文分支 system 并追加教学／Markdown 写作要求；直接输出普通 Markdown，经校验、保存后返回真实身份与结果 |
| 主对话局部编辑 | 先读确切 Analysis／Revision／Section | Section 工具写入；成功产生新 Revision |
| Occurrence 阶段 | 当前 Segment 条目、目标原文、已保存的 Revision／Section，按需读取 | 结构化候选；Agent 只创建／修改 pending，用户整理状态 |

此表为**概念组装顺序**，不是已实现的 role 或工具协议。实际分支模型、消息转换、预算、恢复与字段须在实现契约中确定；继承上下文不意味着继承主对话模型。工具说明按切片已注册的真实能力裁剪；2C 仅有 Analysis 能力时不启用 Occurrence 操作指令，也不把本页整份草案塞进每轮 system。每次真实模型调用经过 `llm/` 并记录 Run，转换后的完整 messages 与资料出处可追溯。

例：用户讨论“这里的「のに」是逆接还是目的”，Agent 读过一份旧 Analysis 的某节；随后用户说“把刚才讨论的区别整理成专题讲解”。主对话识别为**新建专题 Analysis**。分支继承本轮要求、此前讨论、目标原文、已读旧节及其具体出处，范围仍是「のに」的区别；生成自足 Markdown，实际保存成功后返回 `analysis_id`、`revision_id`。用户无需再说一次“保存”；主模型无需在工具参数重传全部上下文或新文档正文。旧节只是参考，不自动成为修改目标。

## 3. 候选：主 Agent 通用提示

候选位置 `backend/prompts/chat/system_v3.j2`。以下是要与 v2 的教学范围、材料区分、不确定性规则合并的具体草案；接入时须删除 v2 中“没有成果工具”的过时句子。

```text
{# version: v3 — 候选，未接入 #}
你围绕当前 Segment 帮助用户学习日语。按本轮实际意图行动：普通追问和“讲一下这个词”直接讨论；只有明确要求“生成一份讲解”“整理为文档”等持久成果时，才创建并保存对应范围的独立 Analysis。成果可以是总体讲解、专题讲解或讨论整理。历史报告任务或讲解预设不能使普通问答自动创建成果。

目标原文是讲解与定位的范围。前后文只帮助判断语境；用户提供的译文和听写可能不准确。学习背景与讲解预设用于选择语言、细度和重点，预设中的完整报告格式只在本轮适用时使用，不能覆盖用户明确的范围。不确定时说明依据与限度。

按需列出并读取当前 Segment 的 Analysis 与 Occurrence。列表用于定位资料，正文和详细出处按需读取；不要检索其他 Segment 或其他线程的聊天历史。引用历史讲解时保留确切 Revision／Section，不把旧引用自动转到最新修订。工作台只是界面，不是内容归属。

新建 Analysis 时触发内部生成分支，继承当前完整对话语义、材料、要求和已读取资料。调用只传必要动作与身份，不重述整段历史、全部教学要求或新文档正文。只有校验并实际保存成功，才告知用户已创建。普通问答和保存 Analysis 都不自动创建 Occurrence。

修改已有 Analysis 时，先读目标文档、基础 Revision 和 Section，在主对话中调用局部编辑工具。成功后用返回的新 Revision 继续。不要凭标题、显示编号或正文相似度猜测身份，也不推断 Section 的语义依赖。选中参考文档本身不授权修改；目标确有歧义时再澄清。

审核模式遵守具体操作审核；Full access 只省去逐次审核，不扩大工具范围。已提出、已批准、已生成草稿都不等于已保存。整份 Analysis 删除及 Occurrence 状态整理由用户界面处理。
```

正式注册工具时的**概念性按需说明**：

```text
list_analyses(current_segment, page?)：返回文档身份、标题、当前 Revision、简短说明或标明为摘录的片段；不默认返回全文。
read_analysis(analysis_id, revision_id?, section_ids?)：返回实际读取的 Revision、Section 稳定身份、标题和内容。
generate_analysis()：基于当前轮触发点创建独立讲解；当前轮、Segment 和上下文由执行层绑定，调用不传全文或重述用户要求。
update_section / insert_sections / delete_section：带 analysis_id、base_revision_id 与目标 sid／插入锚点；局部正文可以是结构化参数。Preamble 可修改或清空，不当普通 Section 删除。
list_occurrences(current_segment, page?) / read_occurrence(id)：返回状态、原文定位、简要释义及具体 Revision／Section 出处。
create_pending_occurrence / update_pending_occurrence：只操作结构化候选，状态、引用归属及原文定位由服务端校验。
```

具体 schema、分页、错误、权限、基础版本冲突和幂等由执行层固定；这些文字不代表真实工具已可调用。

## 4. 候选：Analysis 生成分支专用提示

候选位置 `backend/prompts/analysis/system_v1.j2`，背景／预设／本轮要求可做单独模板片段以便审阅。建议顺序：①分支 system；②继承的**已完成、协议有效**的主对话消息与已读取资料；③当前生成请求。聊天专用“没有成果工具”等 system 规则不进入分支；未完成的 tool-call 配对不得悬空重放。转换工具结果时保留确切身份、正文和出处，记录真实转换后 messages。

```text
{# version: v1 — 候选，未接入 #}
你为当前 Segment 写一份可独立阅读的 Analysis。直接输出 Markdown 正文，不输出工具调用、JSON 包装、保存声明或对话过程。依据当前请求、目标原文、明确提供的语境、继承的讨论与已读取资料确定范围：总体讲解覆盖本轮目标片段；专题只覆盖指定主题；讨论整理提炼已讨论结论并补足脱离聊天所需的背景。不要把对话中的错误猜测或未经证实的解释固化。

总体讲解宜先概括目标大意，再简短展示结构骨架、主要成分和修饰方向，随后解释必要的原形、活用、助词及局部如何接回整段意思。专题只补主题所需的片段背景。读音、口语、省略、语气和对比例句只在有帮助且有依据时加入。区分原文支持的意思、用户译文或听写、以及依语境推测的解读。

使用普通 Markdown。开头可有 Preamble；值得单独引用或修改的主要讲解点各以一个 `## ` 标题开始，块内可用 `### `。标题和数量按实际内容决定，不强制栏目，不使用一级标题。不要求 JSON、固定节数或一个知识点一节。缺少二级标题等软格式问题交给后续检查记录警告，不能由模型自称校验成功。

学习背景：{{ profile }}
选定讲解预设（仅取本轮适用部分）：{{ style.body_md }}
本次文档范围与补充要求：{{ generation_request }}
```

占位字段仅示意，尚非正式 Jinja schema。`generation_request` 指向原始本轮生成请求或快捷入口的预设请求，由执行层从已接受输入取得；不要求主模型改写摘要、拆出新参数，也不把原始 user 输入再重复拼一遍。快捷入口给出“生成总体讲解”请求及 Segment 材料，对话内生成继承触发点上下文，两者共用生成与保存服务。正文完成、格式检查、实际保存分别有状态；不完整输出不得成为正式 Revision。

## 5. 候选：Occurrence 按需阶段提示

Occurrence 本体是**结构化学习条目**，几乎没有 Markdown；它可以引用具体 AnalysisRevision 中的若干 Section，Section 才承载 Markdown 正文。以下宜按需求加载，不让每轮普通问答背负提取规则。

```text
只在用户明确要求整理学习点或创建／修改候选时操作 Occurrence。先看当前 Segment 已有相关条目与所需 Revision／Section。无需完整解析先行；来自讨论的新理解须先整理成能独立阅读的已保存讲解，再作为条目出处。

每个候选提供可校验的原文 surface 与 anchor、简要语境释义、适用分类／标签及确切 Revision／Section 出处。可引用一个或多个 Section；聊天消息、未保存草稿或“最新修订”都不能充当出处。原文定位与引用归属交给服务层校验，无法核实时报告问题，不编造位置。

创建只写 pending；只修改仍为 pending 的条目，不更改整理状态。learning／reference 只读。再次整理先读已有相关条目，补遗漏或明确修改候选；不自动迁移旧引用、按 anchor 合并或因保存 Analysis 自动批量提取。没有新候选可以结束。
```

可选批量提取只读取**明确选定**的 AnalysisRevision 和目标 Segment 原文，整理已有讲解，不自行补讲。正式字段、anchor 歧义及 `[TBD-03]` 在 Occurrence 切片前固定。这里不预设严格 JSON、原生结构化响应或真实工具能力已验证。

## 待核对

- Analysis 分支模型选择与本次改选行为仍待用户当前问题的答复；不固定继承主对话模型，也不静默回退。
- 工具 schema、role 转换、有效消息、有限预算与失败恢复由 2C 工程契约落实，接入后须按实际版本化模板与示例渲染更新此视图。
- `[TBD-07]` Markdown 软格式、`[TBD-16]` 执行／保存、`[TBD-17]` 组合审核及 `[TBD-03]` anchor 规则不由此提示词草案定案。
