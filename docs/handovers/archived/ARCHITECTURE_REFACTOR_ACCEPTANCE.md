# 编辑规则与讨论状态重构验收

> 2026-10-02 至 2026-10-03，评审基准 `a07912c`。本次保持已确认产品行为，不扩展 Occurrence 或组合工具契约。

## 清理计划与基准

1. 核对工作区，保留已有 `AGENTS.md` 修改；先运行基准检查。
2. 为审核预览与保存的一致性补回归，再把编辑合法性、Markdown 变换和身份映射集中到 Analysis 服务。
3. 为讨论的提交、核实、版本合并、终态通知和阅读保护补组合测试，再集中实际状态推进入口。
4. 完整检索调用后删除不可达的旧 Job 执行路径，保留活跃收尾职责。
5. 独立 CR、针对性测试、完整检查与隔离浏览器验收通过后收口。

开工前 `just lint`、`just test` 通过：后端 173 项、前端 18 项。实现与 CR 分开进行，主代理负责集成验收。

## 后端边界

- `services/analyses.py` 的编辑目标读取与纯变换供审核和保存共同使用，统一 NFC、标题 trim、二级标题约束、插入锚点、行终止、长度和块身份映射。
- `jobs/agent.py` 保留权限、具体方案、等待审核与执行授权；批准后仍在保存事务内重新核对归属、基础版本和操作身份。历史 Revision 不变，重复决定不重复生成 Revision。
- `jobs/runtime.py` 删除分派返回后的旧单 Run 执行代码，以及仅由它使用的进度／状态 helper、异常、常量和导入；删除测试中无效的 `STOP_GRACE_SECONDS` monkeypatch。保留 `_finish`、领取、授权、停止、恢复、线程释放。
- 新回归复制到 `a07912c` 的独立临时归档运行，10 项中 8 项失败，识别旧预览的 NFC／trim／换行差异和非法操作进入审核；当前后端 183 项通过。

## 前端与集成验收

- `chat/discussion.ts` 的协调器统一受理与核实后的实际推进、Job 缓存版本合并、终态刷新和一次性成果通知。`Workbench.tsx` 使用同一受理入口，草稿采用函数式更新。
- `SegmentPage.tsx` 在首次提交时按 `request_id` 记录阅读位置；受理回调前先收到终态时也可使用该快照。`AnalysisPanel.tsx`、历史消息和活动任务读取／停止均复用版本合并。旧的状态模块只保留兼容重导出，删除重复判断。
- 离线测试直接调用生产受理／观察入口，使用真实 QueryClient 和假 API 检查缓存、草稿、刷新及通知；CR 发现的旧草稿覆盖、核实前成果导航与遗漏 Job 读取入口均已修正。

最终检查：`just lint`、`just test`、`just build`、`just check-docs`、`git diff --check` 通过。后端 **183** 项、前端 **29** 项测试通过。无 schema 变化，无需重新生成 API 客户端。

浏览器使用隔离 FastAPI／Vite 与临时数据库，假适配器仍经真实 worker、Job／Run、服务层和持久化；模拟延迟正常受理响应、受理后返回 503、延迟按请求核实，以及可取消的模型调用。

| 场景 | 实际观察 |
| --- | --- |
| 普通提交／延迟受理 | 问题进入持久历史并完成回答；正常响应延迟 8 秒时，期间新写的草稿保留 |
| 插入与 Preamble 审核 | 显示目标、基础修订、原内容和拟保存内容；批准后新修订正文包含所展示内容，成果链接携带确切 Revision |
| 本页状态保留 | 问题草稿与审核附加要求在返回讨论列表、重新打开及收起／展开后保留 |
| 停止 | 运行中依次显示正在停止、已中断，线程释放；已有持久讲解仍可阅读 |
| 丢响应核实 | 显示提交待核实；返回列表后后台核实完成，再进入时改写的新草稿保留 |
| 同请求重试 | 使用同一请求重试后保留改写草稿；临时库核对该问题仅一个 Job、一个 request_id |
| 丢响应后切换阅读 | 提交生成后切换至已有历史修订；新讲解保存且核实完成后，URL 与正文仍保持用户选择的历史 Revision |
| 快捷生成与讲解面板停止 | 停止后显示未保存新讲解，已有内容保留；再次生成成功后自动打开新成果的确切修订，普通问题草稿未被清空 |

快捷生成最终验收曾发现共享 Job 观察反复写入同版本缓存，造成 React 更新循环和白屏。`mergeJob` 改为合并结果不变时不写缓存；新增真实 QueryCache 订阅回归。随后重新运行完整 lint／test／build，并重测快捷生成、停止与成果阅读，未再出现白屏或新增控制台错误。

## 修改文件

| 范围 | 文件 |
| --- | --- |
| 后端编辑与执行 | `backend/src/app/services/analyses.py`、`backend/src/app/jobs/agent.py`、`backend/src/app/jobs/runtime.py` |
| 后端回归与清理 | `backend/tests/test_analyses.py`、`backend/tests/test_analysis_agent.py`、`backend/tests/test_analysis_workflow_acceptance.py`、`backend/tests/test_chat_runtime.py` |
| 前端讨论模块 | `frontend/src/chat/discussion.ts`、`frontend/src/chat/discussion.test.ts`、`frontend/src/chat/state.ts`、`frontend/src/chat/Workbench.tsx` |
| 页面接入 | `frontend/src/SegmentPage.tsx`、`frontend/src/analysis/AnalysisPanel.tsx`、`frontend/src/analysis/state.ts` |
| 文档 | `docs/ARCHITECTURE.md`、`docs/handovers/README.md`、`docs/handovers/MVP_IMPLEMENTATION_BASELINE.md`、本验收记录 |

工作区原有 `AGENTS.md` 修改原样保留，不纳入本次重构提交。本次重构在 `codex/analysis-discussion-refactor` 分支按编辑规则、死代码清理、前端状态推进与验收文档分批提交，保留 `a07912c` 作为评审基准。

## 未决项与限制

- 沿用 TBD-07 的现有 Markdown 占位和 TBD-16 已落实的 Analysis 执行契约；不扩展 TBD-07／16／17，不预设 Occurrence。
- 未新增依赖，未改变数据库或 OpenAPI schema。
- 浏览器使用独立临时数据库、虚构素材及假模型适配器，禁用模型网络；不证明真实模型质量或第三方兼容性。
- 草稿保留范围仍是当前片段页面内的讨论列表与收起操作，不承诺刷新或离开页面后恢复。
- 活跃 Job 收尾职责的进一步合并留作后续建议，本次未实施。
- 构建仍有主 JS 包大于 500 kB 的既有提示，本次未扩展为性能拆包任务。
