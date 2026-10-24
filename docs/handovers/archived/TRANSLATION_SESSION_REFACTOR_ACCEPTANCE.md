# 翻译会话深化验收

日期：2026-10-24。代码起点：`e563da7`。本记录维护本轮清理顺序、回归证据与验证限制；现行机制见 [ARCHITECTURE](../../ARCHITECTURE.md#48-阅读翻译与设备朗读)，交付状态由[实施基线](../MVP_IMPLEMENTATION_BASELINE.md)维护。

## 清理计划与行为基线

本轮已完成只读架构审查与方案比较，用户授权按以下顺序实施：

1. 将同目标双翻译卡的草稿失同步补成浏览器失败回归，再覆盖真实 Reader 的入口往返。
2. 由 Reader 持有按确切目标索引的会话，集中草稿与初始化；呈现入口读取同一快照，移除草稿镜像与回写。
3. 集中生成门禁、固定请求、并发提交和未知结果核实；分开会话受理任务与各入口历史选择。
4. 删除外露的可变会话与手工通知协议，完成 interface、浏览器及工程验证。

设计比较选择对象会话与薄 React 绑定。独立设计复核补充了主动分页消费自动意图、发 POST 前复核活动任务、发起入口的查看代次，以及 Reader 解绑时区分未发送和已发送请求。实施与浏览器回归分工，集成后另行审查。

保留 TanStack Query 对服务端数据的读取与缓存职责、材料级后台任务观察、精确出处身份和采用译文的独立流程。客户端固定请求体与 UUID，实际模型配置继续在后端受理时固定。无后端 schema、依赖或 TBD 变更。

## 验证记录

修改生产实现前，已完成两条真实浏览器失败回归：

| 场景 | 重构前结果 |
| --- | --- |
| 两个真实 TranslationPanel 共用目标与会话，原浮卡 hidden 保活；嵌入式修改后重开原卡 | 期望“双宿主独特草稿”，实际仍为“前文。”；同时核对原 textarea DOM 未被重新挂载 |
| 真实 MaterialReader 选已译原文，关闭浮卡后从本章记录编辑同目标，再次选择该原文 | 期望保留记录入口的新语境，实际仍为“春の風が静かな庭を通り抜ける。” |

失败日志分别为 `/private/tmp/folio-translation-r1-red.log` 和 `/private/tmp/folio-translation-r2-red.log`。这些是本机临时证据，不随仓库分发；持久回归位于 `frontend/browser-tests/translation-session.tsx` 与 `chapter-records.tsx`。

## 实现与测试迁移

| 文件／范围 | 结果 |
| --- | --- |
| `translation/session.ts` | 目标会话注册表、不可变草稿快照、初始化、自动意图、提交占用、固定请求及 Reader 绑定代次集中在同一 module |
| `translation/session-react.ts` | 现有 HTTP／Query adapter 与 React 订阅；POST 响应不确定也刷新材料活动，同任务终态事实优先于其他缓存中的旧活动状态 |
| `TranslationPanel.tsx` | 删除共享草稿镜像与回写，移除提交状态的手工联动；每个入口独立选择结果、任务或当前历史页 |
| `MaterialReader.tsx`、`ChapterRecords.tsx` | 共用 Reader 持有的注册表，维持现有呈现、朗读及导航职责 |
| `state.ts`、`state.test.ts` | 删除可变 TranslationSession 与 notify，移除直接改内部字段的通知测试；保留身份、NFC 与采用流程仍使用的固定请求工具 |
| `session.test.ts` | 新增 16 项生产 interface 回归，以可控查询和提交结果验证状态规则 |
| 浏览器回归 | 双 Panel 及真实 Reader 的失败回归转绿，保留既有历史、采用、未知响应、布局和后台完成断言 |

interface 回归覆盖双入口共享快照、迟到设置与清空、预算保护、并发占用、异目标并行、原请求核实、前置失败与明确拒绝、自动意图和分页、活动任务最终检查、Reader 解绑与重绑、已发送请求完成、recent 原语境重做、预装失败后的人工提交，以及同步订阅回调重入。

独立审查发现并修复三类呈现隔离问题：显式历史任务读取失败时借用了其他活动任务；未知提交核实被当前活动任务或结果读取阻断；翻页后重新跟随共享受理任务。分别补充浏览器回归，最终独立复核未发现剩余阻塞问题。

## 工程与浏览器验收

- `just lint` 通过：Ruff、Pyright、Biome、TypeScript 和 JavaScript 语法检查。
- `just test` 通过：后端 **610** 项、前端 **462** 项；其中翻译纯逻辑共 24 项，含新增会话回归 16 项。
- `just build` 通过：主 JS 936.68 kB，保留超过 500 kB 阈值的构建提示。
- `just test-browser` 全量 **24** 组配置通过，包括 translation、chapter-records、reading-aids、theme 及既有综合回归。
- `just check-docs` 通过：88 份文档、873 个本地链接有效；`git diff --check` 通过。

浏览器使用真实生产呈现与本地 HTTP 替身。实际断言包括：双入口编辑前后文、清空和修改预算后同步，原浮卡保活重开显示新语境，实际提交采用最新值；一个入口查看旧结果或翻到旧页，另一个入口受理新任务不会改变它的选择；显式历史任务加载失败不显示其他任务的停止按钮；历史、设置、旧结果读取失败或发现活动任务时，未知提交仍能以原 UUID 和完整请求体核实。

真实 Reader 的本章记录矩阵覆盖 1280／320px、横／竖排、亮／暗主题和关闭入口后的后台完成，共 11 组。阅读辅助继续覆盖宽窄及短屏、真实 iframe 原文、关闭翻译后朗读保留和离开 Reader 清理。

最终日志位于本机 `$TMPDIR` 下的 `folio-translation-final-{lint,test,build,browser,docs}.log`；定向红绿日志位于 `/private/tmp/folio-translation-*.log`。这些原始日志为临时证据，持久行为依据是仓库测试与本记录。

## 范围与限制

浏览器与单元测试使用本地替身，不访问真实模型或日常数据库。未验证真实模型质量、实体触屏、Safari／Firefox；整页刷新不承诺恢复未提交草稿。采用表单、后端任务与持久快照不在本轮重构范围。没有新增依赖、后端 schema 或 TBD 决策，未重新生成客户端。
