# 路由代码按需加载验收

日期：2026-10-25。代码起点：`84d6573`。本轮仅调整前端页面加载边界；未纳入并行进行的 EPUB 存储改动。

## 范围与取舍

默认素材库继续同步加载；阅读器、片段、来源、书籍详情与设置页面改为模块顶层 `React.lazy`。共享依赖与 CSS 由 Vite 自动拆分，未新增依赖、手动划分 vendor 或提高构建警告阈值。

阅读器加载／错误边界保留在 `RetainedRoute` 内部，不随外层 pathname 变化重建。其余页面边界按 pathname 重置错误状态，查询参数变化保留组件身份；Reader、Settings 与 Workbench 内部的保活、位置、草稿和查询逻辑保持原实现。等待时显示加载状态，失败时允许重新加载当前地址。

实施前补齐真实 App 路由回归并通过，再修改加载边界；独立代码复核未发现需修正的行为回归。参考 [React lazy](https://react.dev/reference/react/lazy)、[Suspense](https://react.dev/reference/react/Suspense#caveats) 和 [Vite CSS 分包](https://vite.dev/guide/features.html#css-code-splitting)。本轮不涉及 TBD、后端 schema 或 API 变化。

## 生产构建与冷加载比较

同机使用相同锁定依赖，先保存起点的生产构建，再构建优化版本。环境为 macOS、Node 26.10.0、pnpm 10.34.5、Chrome 155.0.8059.85、React 19.3.0、Vite 8.3.1。

测量脚本见 [`measure-loading.mjs`](../../../frontend/scripts/measure-loading.mjs)。两份生产构建交替运行，每条路由各五次；每次使用新浏览器上下文、禁用 HTTP 缓存，1280×900、无 CPU 或网络限速。本机静态服务器不启用传输压缩，API 使用空素材库和固定学习设置夹具。响应体大小不包含 HTTP 头；时间为导航开始至目标 DOM 可用的中位数：素材库以空库导入入口出现为准，设置以学习背景输入框出现为准。

| 指标 | 优化前 | 优化后 |
| --- | ---: | ---: |
| 素材库首次实际 JS | 990.10 kB | 425.48 kB（减少 57.0%） |
| 素材库首次实际 CSS | 179.71 kB | 80.46 kB（减少 55.2%） |
| 最大单个 JS 产物 | 990.10 kB | 279.99 kB |
| 素材库 DOM 可用中位数 | 65.7 ms | 49.4 ms |
| 首次直达学习设置实际 JS | 990.10 kB | 503.67 kB |
| 首次直达学习设置 DOM 可用中位数 | 56.6 ms | 345.7 ms |

素材库五次 DOM 可用时间：优化前 71.0／65.7／58.5／66.5／57.5 ms，优化后 46.7／49.4／49.0／52.5／49.7 ms。首次直达学习设置分别为 57.6／56.6／55.2／58.4／54.6 ms 和 345.7／340.2／350.4／350.4／343.6 ms。

生产构建成功，默认 500 kB 大包警告消失。初始 JS 包为 279.99 kB，另预加载 145.49 kB 公共包，两者均计入上表。全部功能的 JS 产物合计由 990.10 kB 变为 995.39 kB；本轮减少首次加载负担，全部下载后的代码总量略增。全部 CSS 合计约 179.72 kB。

首次直达设置增加约 289 ms，是本轮已测的异步加载等待代价；本轮保留这一取舍，不将结果描述为所有页面更快。再次进入已载入模块不重新下载页面代码。以上本机空库测量不代表真实后端、模型、弱网、移动设备或 EPUB 首次呈现耗时；项目指定的 Node 24 尚未单独复测。

## 行为与失败验证

- 新增 `route-loading` 浏览器套件，挂载真实 `App`，覆盖 1280×900、390×900 和竖排。400 段／三个 iframe 的 Reader → 真实 Segment → Reader 往返保留 iframe 和 Document 身份，精确返回第 350 段、无目标返回及历史前进后退保留位置。
- 讨论打开、输入草稿、隐藏、重新打开后保稿。设置未保存时离开被拦截，继续编辑保留原字段及草稿，放弃修改后完成导航；同路径分类切换也验证草稿保护。
- 可控 lazy Promise 验证加载提示、成功呈现及失败提示／重新加载按钮，纳入长期浏览器回归。
- 生产分包故障注入验证：默认素材库不请求次级页面包；延迟设置包时显示加载、允许返回素材库，迟到完成不替换当前页面；再次进入可用。拒绝设置包时显示错误，跨路径离开能恢复素材库，网络恢复后重新加载原地址可打开设置。
- 在应用浏览器实际打开生产构建，观察素材库与设置完整布局；编辑学习背景后离开出现未保存提示，选择继续编辑后原草稿保留。

`just lint`、`just test`、`just build`、完整 `just test-browser`、`just check-docs` 和 `git diff --check` 通过。后端 672 通过、1 跳过，前端 602 通过；跳过项为既有测试。完整浏览器 58 组通过，后续补充的加载边界与分类切换回归又单独跑完三组；没有真实网络、模型或用户数据写入。

本机原始记录保存在 gitignore 的私有证据目录：[冷加载样本](../../../data/acceptance-evidence/route-loading-20261025/loading-comparison.json)、[生产分包故障注入](../../../data/acceptance-evidence/route-loading-20261025/chunk-check.log)、[完整浏览器](../../../data/acceptance-evidence/route-loading-20261025/browser.log)、[最终边界回归](../../../data/acceptance-evidence/route-loading-20261025/route-loading-final.log) 和[工程测试](../../../data/acceptance-evidence/route-loading-20261025/test.log)。隔离工作树通过既有私有证据目录的链接核验文档引用，不复制或连接用户数据库。

## 合入前复核（2026-10-25）

在托管工作树重新执行完整 `just check`，lint、类型检查、后端 672 通过／1 跳过、前端 602 通过、生产构建、文档链接及最终 58 组浏览器回归全部通过；最终浏览器运行包含加载边界故障和设置分类草稿保护。日志见[合入前完整检查](../../../data/acceptance-evidence/route-loading-20261025/merge-check.log)。

提交范围只含路由加载、相关测试、测量脚本和配套文档；后端、EPUB 存储、数据库和依赖保持提交起点的版本。首次直达设置的已测等待代价沿用上文记录。

## 主分支整合复核（2026-10-27）

整合 `main` 的路由按需加载（`497d9ed`）与 EPUB／阅读会话分支（`0ff35f6`），保留双方提交历史。生产页面继续注册到 DataRouter；`ReaderSessionHost` 通过模块顶层 lazy 加载，阅读与片段路径共用稳定的加载／错误边界。页面匹配使用 Router 的 `matchRoutes`，避免尾斜杠直达时空白。其他页面继续按 pathname 重置错误边界。

真实 App 回归覆盖尾斜杠冷启动、普通／尾斜杠地址切换、片段往返及历史前进后退，核对三个 iframe 与 Document 身份、阅读位置、讨论草稿和设置离页保护。双方目录、导入、阅读动画和会话失效场景均保留。独立复核发现的尾斜杠问题已修复，新回归可捕获原错误。

隔离工作树的 `just lint`、`just test`、`just build`、`just check-docs` 和完整 `just test-browser` 通过：后端 742 通过、1 跳过，前端 611 通过，浏览器 73 组通过。完整浏览器首轮被修复时的热更新中断，最终在稳定源码上重新跑完。应用浏览器中实际观察到第 350 段精确返回、日语正文／注音、片段标记与工具栏正常呈现。环境为 macOS、Python 3.11.14、Node 26.10.0；Node 24、实体触屏及其他浏览器引擎未单独复测。未调用真实模型，也未连接用户数据库。

原始记录：[静态检查](../../../data/acceptance-evidence/docs-review-20261027/lint.log)、[后端与前端测试](../../../data/acceptance-evidence/docs-review-20261027/test.log)、[生产构建](../../../data/acceptance-evidence/docs-review-20261027/build.log)、[完整浏览器回归](../../../data/acceptance-evidence/docs-review-20261027/browser.log)。本次未纳入原工作区并行进行的前端优化及其后续文档更新。
