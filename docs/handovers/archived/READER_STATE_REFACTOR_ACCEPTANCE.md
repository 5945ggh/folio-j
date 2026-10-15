# 阅读恢复、注音偏好与来源导航重构验收

> 2026-10-10，起点 `d9e97fa`，分支 `codex/reader-architecture-depth`。实现提交：阅读器 `f860edf`、来源导航 `06a1177`。

## 范围与清理顺序

本轮按架构调查中的三个候选顺序实施：阅读重排与恢复、异步注音偏好提交、Source 导航状态。产品行为、材料版本与码点身份、原书 ruby 优先、失败保留、确切修订和来源查询隔离沿用现行契约；没有 schema、依赖或 TBD 变化。

先写清理计划并独立审查，再运行原有 18 项针对回归。第一项保留原 AST 提取测试中的生产时序断言；第二项先新增 4 项执行真实 `changeBookUi` 的临时表征测试；第三项先从当前 TSX 执行视图切换和窗口开关，核对查询清理及历史模式。行为基线通过后逐项集中职责，测试改为直接调用生产 module，最后执行独立审查与综合验收。

开发代理负责阅读器实现，测试代理独立维护注音提交测试并复审三项改动，主代理负责来源导航、集成及浏览器验收。审查发现新 surface 即使 geometry 相同也必须使旧采样许可失效，已在 `ReaderLayout.commit` 修复并补回归。

## 修改结果

| 范围 | 文件与职责 |
| --- | --- |
| 阅读重排 | `materials/reader-layout.ts` 集中锚点、保存定时器、恢复票据、几何判定与资源就绪；`MaterialReader.tsx` 保留 DOM 投影、定位及绘制前的 layout effect |
| 偏好提交 | `materials/preference-submission.ts` 集中资源等待、过期结果隔离、几何变化分类、存储与提交结果；页面以 layout effect 绑定最新上下文，卸载时 suspend |
| 来源导航 | `catalog/state.ts` 集中默认排序、视图切换、窗口开关及历史模式；`hooks.ts` 适配 Router／Storage，`SourceViews.tsx` 使用同一入口 |
| 回归 | `reader-layout.test.ts`、`preference-submission.test.ts`、`source-navigation.test.ts` 直接调用生产 module；删除旧票据对象、AST 回调提取及 `ruby-reset.test.ts` 中的流程复写 |

新 interface 测试保留原回归语义，并覆盖恢复失败禁采样、重复／过期就绪、首次空 frames、同几何新代次、迟到成功与失败、章节失效、suspend 后重新绑定、连续重置以及来源导航的连续转换。现有 `ViewportRecovery`、正文投影和 `PositionQueue`／持久化测试继续保留，各自仍覆盖独立行为。

## 工程验证

- `just lint` 通过，包括 Ruff、Pyright、Biome 和 TypeScript。
- `just test` 通过：后端 244 项、前端 122 项。模型和网络测试禁令保持不变。
- `just build` 通过；主 JS 包为 670.23 kB，仍有超过 500 kB 的既有构建提示，本轮没有扩展为拆包任务。
- `just check-docs` 与 `git diff --check` 通过；文档检查覆盖 50 份文档、455 个本地链接。

## 浏览器验收

使用独立临时 SQLite、合成 EPUB、两个 Source、三个手动 Segment 和一份合成 Analysis。后端禁用模型任务，前端开发环境与后端构建产物分别打开；没有使用或修改日常数据库。默认视口 1280×720，窄屏 390×844；临时视口覆盖在验收后恢复。

| 场景 | 实际观察 |
| --- | --- |
| 正文中段修改字号 | 从 22 调到 28 后仍在“検索対象20”附近，未回到章首 |
| 全量与隐藏注音 | 原书范围切全量后补出读音，仍在同一段；隐藏读音时正文位置与几何保持 |
| 连续恢复默认 | 两次恢复默认后仍在章内 14%；临时库确认位置继续写入，横排检查时 offset 为 586 |
| 横排转竖排、视口改变 | 竖排保持同一阅读段落；缩到 390px 后“検索対象20”仍在阅读起始侧，回宽屏保持 14% |
| 章节导航与返回点 | 跳到末章后出现“返回跳转前”，执行后回第一章 14%，返回点消费 |
| 书籍窗口往返 | 带来源查询展开全部书籍，搜索 R1.1 后打开 Reader；其返回链接携带完整查询，浏览器后退恢复窗口和搜索 |
| 关闭与切换视图 | 关闭书籍窗口清理正文筛选，保留来源栏查询；切讲解后正文查询与来源查询分别生效 |
| 确切讲解与历史导航 | 搜索“合成”，打开带 Analysis／Revision 的入口；点击来处返回后两区查询保留。切素材后浏览器后退恢复讲解与搜索，前进恢复素材 |
| 来源窄屏 | 素材视图显示切换来源、四个视图和书卡，无横向溢出 |
| 构建产物 | FastAPI 托管的最终构建重新打开后恢复到同一竖排正文，独立标签的错误／警告日志为空 |

本机证据位于 `/tmp/folio-architecture-qa-20261010/`：`reader-full-ruby.png`、`reader-reset.png`、`reader-return.png`、`reader-narrow.png`、`source-book-return.png`、`source-analysis-return.png`、`source-narrow.png`，以及隔离数据的 `manifest.json`。临时证据不随仓库分发。

开发页在实现过程中经历热更新，曾显示乐观版本冲突；最终重新载入后验收通过。浏览器自动化期间的开发标签还记录了缺少调用栈的 MutationObserver 错误，未将其归因于产品；最终构建的新标签没有出现该错误。异步延迟与失败用直接生产 module 的离线测试验证，本轮没有在浏览器重新注入全部网络故障。

## 用户复测与提交复核

2026-10-10，用户再次测试后反馈“没有发现问题”，并同意提交。用户未列出逐项测试范围，本记录保留上述工程与浏览器验收的具体边界。

提交前重新运行 `just lint`、`just test` 和文档链接检查，均通过；测试仍为后端 244 项、前端 122 项。实现按阅读器和来源导航分别提交，架构说明、实施基线及本验收记录另行提交。未修改数据库 schema、依赖或产品未决项。

## 最佳实践依据与限制

- [React useLayoutEffect](https://react.dev/reference/react/useLayoutEffect)：同步几何测量与恢复保留在绘制前，未把异步资源请求搬入其中。
- [React useEffect](https://react.dev/reference/react/useEffect) 与 [useRef](https://react.dev/reference/react/useRef)：协调对象纯构造，生命周期失效与最新上下文绑定在 effect；可显示状态仍由 React 管理。
- [TanStack QueryClient](https://tanstack.com/query/latest/docs/framework/react/reference/classes/QueryClient) 与 [Query Cancellation](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation)：保留现有请求键、缓存及 signal 行为；隔离旧偏好意图不取消共享查询。

核对版本为仓库 React 19.3.0、TanStack Query 5.104.0，资料核对日期 2026-10-10。没有借本次重构迁移 QueryClient 方法。

本轮未增加实际 React StrictMode 挂载测试；其 suspend／bind 失效语义已通过 module 测试。未验证实体触屏、Safari／Firefox、第三方扩展、真实模型质量或不同真实书籍的全部排版组合。上述限制不改变既有产品契约。
