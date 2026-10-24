# 素材库 A.1 集成验收记录

> 2026-10-24 本机资产整理：本文链接的证据已迁至私有归档；旧验收数据库、构建与脚本已清理。以下 `temp/` 路径和服务地址记录当时环境，保留范围见[本机证据保留说明](../LOCAL_EVIDENCE.md)。

> 历史阶段资料（2026-10-20 归档）。现行规则见[PRD](../../../PRD.md)与[架构](../../../ARCHITECTURE.md)，当前交付和未完成验收见[实施基线](../../MVP_IMPLEMENTATION_BASELINE.md)。

日期：2026-10-05。状态：实现、综合检查与本轮浏览器验收通过。本文只记录本轮工程结果，2026-10-04 前端调整与离线原型的历史证据保持原记录。

实现提交：`adb7cc2`（封面提取与版本化缓存）、`3dbfb34`（素材库 A.1 与共享书卡）。

## 实现与命令结果

素材库已接入 A.1 类型／工具同排、搜索筛选展开与条件清除、合并排序、卡片大小、真实封面书卡／三点状态菜单、真空库整区导入、单页简化计数。导航名称与图标已调整；公共书卡复用未重排 Source 页面，Reader 与 Segment 工作台未重做。

封面规则与最终代码核对见[工程契约](API.md)：版本 2、声明／spine／manifest 顺序、旧成功失败懒重建、增量迁移与诊断保留。两本真实样书的旧误拒原因是 JPEG EOI 后的尾随字节；修复未改变格式支持范围。独立代码审核发现的零组件／空熵扫描误接收、回退成功丢诊断及窄屏卡片大小失效均已修复并复核。

主代理报告本轮 `just gen-api`、`just lint`、`just test`、前端生产构建、文档检查及 `git diff --check` 均通过：后端 244 项、前端纯逻辑 54 项、实验 4 项，共 302 项。封面最终完整后端套件通过，独立 QA 28 项复核通过。生产主包 608.25 kB，仍有既有体积提示；未新增依赖。文档代理已阅读最终提取／缓存／目录／迁移和素材库展示代码核对契约，不将上述主代理运行结果描述为自行重跑。

## 已验证浏览器与缓存行为

主代理使用独立测试库验证：

- 空库整片留白点击、Enter／Space 进入导入，取消焦点返回空库入口；新建 Source 导入第一本，再向已有 Source 导入第二本。
- 返回素材库后两本真实封面成功解码，尺寸为 1120×1600、1443×2048；封面完整展示，无全书进度槽、常驻状态下拉与重复来源。
- 三点菜单修改完成状态不触发阅读导航；503 时保留原状态并显示错误，解除故障后可重试。
- 条件无结果独立显示；旧版本失败缓存重新生成版本 2 声明封面。缓存 QA 核对原始字节／不可变产物 hash、材料版本／ID、完整阅读位置保持不变。
- 已留存[空库](../../../../data/acceptance-evidence/library-a1-acceptance/evidence/empty-wide.jpg)、[两本真实封面](../../../../data/acceptance-evidence/library-a1-acceptance/evidence/two-real-covers-wide.jpg)、[菜单失败](../../../../data/acceptance-evidence/library-a1-acceptance/evidence/status-failure-menu.jpg)、[无结果](../../../../data/acceptance-evidence/library-a1-acceptance/evidence/no-results.jpg)、[旧缓存重建](../../../../data/acceptance-evidence/library-a1-acceptance/evidence/old-cache-rebuilt.jpg)与[阅读器回归](../../../../data/acceptance-evidence/library-a1-acceptance/evidence/reader-regression.jpg)截图。

真实样书与参考封面只留用户本机，不放公开仓库或站点。用户原日常库仅进行只读调查，未迁移；独立测试库验证迁移与重建，无删库重导。

封面调查见[本机后端报告](../../../../data/acceptance-evidence/library-a1-acceptance/COVER_REPORT.md)，不变式核对见[旧缓存验证 JSON](../../../../data/acceptance-evidence/library-a1-acceptance/old-cache-verification.json)。以上本机证据为 gitignored 本机文件；不随公开仓库分发，仓库读者可能无法访问。综合命令输出由主代理工具执行确认，未另存日志文件。

## 补充浏览器验收与限制

最终生产构建在独立验收入口 8773 验证以下行为：

- 55 本书分页为首 50 本／末 5 本，最近打开／降序与搜索条件可见；有书但筛选零结果显示无匹配和清除入口，无整区空库导入。目录 503 时先显示加载再显示错误／重试，从未冒充空库，故障解除后重试成功。见[多页窄屏](../../../../data/acceptance-evidence/library-a1-acceptance/evidence/pagination-narrow.jpg)、[目录失败](../../../../data/acceptance-evidence/library-a1-acceptance/evidence/catalog-failure.jpg)。
- 320px 下长混合标题保持两行（实测高 44.8px）及完整 `title`，文档宽 320px 无横向溢出；390px 卡片大小 280 时单列、140 时双列，实测卡片宽度分别准确。见[长标题](../../../../data/acceptance-evidence/library-a1-acceptance/evidence/long-title-320.jpg)、[真实封面窄屏](../../../../data/acceptance-evidence/library-a1-acceptance/evidence/two-real-covers-narrow.jpg)。
- Source 保留原主从结构和三视图，共享书卡显示真实图片，1280px 无横向溢出；菜单 End 聚焦末项，Escape 返回触发按钮。见[来源页回归](../../../../data/acceptance-evidence/library-a1-acceptance/evidence/source-regression-wide.jpg)。本轮只同步共享书卡与导航命名／图标，Source 页面风格可继续独立设计。
- Reader 图文、章节与工具沿用原布局可用，阅读返回保留 `q`／`sort`／`order`；目录滚动从 1392px 打开书再返回仍为 1392px。见[滚动返回](../../../../data/acceptance-evidence/library-a1-acceptance/evidence/scroll-return.jpg)。Reader 风格可继续独立设计。
- Segment 确切历史修订 `65KCPG` 定位准确，390px 无溢出，讨论草稿收起重开不丢，1280px 保持原布局；未调用真实模型。见[工作台宽屏](../../../../data/acceptance-evidence/library-a1-acceptance/evidence/workbench-regression-wide.jpg)、[工作台窄屏](../../../../data/acceptance-evidence/library-a1-acceptance/evidence/workbench-regression-narrow.jpg)。
- 封面临时 503 后显示占位；恢复服务并点击同卡片菜单“重试封面”，资源带 `?v=2&retry=1`，实际解码宽 1443px，无需刷新页面，验证旧失败状态可解除。

迟到导入测试从 A.1 加号提交延迟 3 秒的合成书后取消，路由始终保持 `/materials?type=book&sort=title&order=asc`，最终计数由 55 增至 56，迟到结果没有抢导航。临时运行入口为原型 8771、开发前端 5175／API 8772、生产验收 8773，这些地址不作为持久成果链接。

未触及新 TBD；全书进度、播放器、书架、删除／元信息编辑、Occurrence 等未来功能不在本轮范围。结构校验不是完整图像解码，浏览器失败仍使用占位与重试。

## 2026-10-19 导入来源表单调整

工作区基于 `8268c61`。本轮按用户确认，将添加书籍与新建来源拆为同一弹窗内的两个完整视图，清理重复操作与正常创建后的恢复说明；行为见 [PRD](../../../PRD.md#421-本轮材料目录与阅读管理)，视图、焦点与临时状态见[信息架构](../../../INFORMATION_ARCHITECTURE.md#当前界面职责与路由)。

清理计划先锁定已有文件保留、来源归属和材料发布行为，再拆视图、整理局部样式与反馈，最后检查返回、关闭和迟到结果。独立代理先审查计划，实施后另一次独立代码审查未发现可行动问题。复用 SourceForm 和现有控件，不新增依赖、接口或 TBD。

改动前运行材料／注音相关后端测试 8 项和前端测试 194 项，全部通过；在隔离数据库中确认原流程选择 EPUB、创建来源后仍可直接导入。改动后 `just lint`、`just test`（后端 286 项、前端 194 项）及 `just build` 通过。构建仍有主包超过 500 kB 的既有提示。

新建时只呈现来源字段和创建／返回操作；成功先更新来源选项，再返回并选中新来源。导入视图通过 hidden 保留文件输入，文件名由弹窗会话中的 File 显示。来源字段在提交中禁用并阻止重复提交，返回和 Escape 受同一提交状态保护；导入后的关闭继续遵循迟到结果不抢导航的边界。弹窗使用素材库配色和设置表单的圆角、字号与间距，正文可滚动，操作区独立保留。

**验证边界：** 改动后的浏览器访问被权限检查拒绝，用户随后明确由其自行进行 e2e，本轮未完成最终界面的视觉与交互验收。用户重点复测：

1. 先选择 EPUB，再新建来源；表单视图只显示来源字段，创建后回到导入、显示原文件名并自动选中新来源，可直接导入阅读。
2. 从新建视图返回或按 Escape，保留原文件与来源选择；创建失败时保留草稿，创建中不能返回或重复提交。
3. 导入失败后更换文件重试；导入中关闭窗口，完成后书籍仍在目录且不强制打开阅读。
4. 桌面与窄屏的字段、长文件名、按钮和滚动；Tab 不进入隐藏视图，切换视图及关闭后的焦点可达。

### 用户复测后的配色与文件取消修复

用户反馈首轮样式改善，并提供导入弹窗与来源空间黑色主按钮的截图，要求统一黑灰色、增加来源下拉箭头右侧留白，修复取消系统文件选择器会退出整个弹窗的问题。

本轮将弹窗内强调色设为 `#111`，主按钮悬停使用来源空间已有的 `#2b2b2b`；文件／新建入口、焦点与辅助状态使用黑灰色。来源选择保留原生 select，以装饰箭头固定右侧 14px 留白并预留文字空间。

文件选择器的 cancel 事件会冒泡，见 [MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/cancel_event)；原共享弹窗误把它交给关闭回调。现在共享取消处理只接受来自弹窗自身的事件，并保留 preventDefault 与提交中回调拒绝关闭的行为。三项离线回归先证明文件取消会误关闭，再通过修复：后代控件取消不关闭、弹窗自身取消的处理顺序、提交中拒绝关闭的默认行为保护。

`just lint`、`just test`（后端 286 项、前端 197 项）、`just build`、`just check-docs` 与 `git diff --check` 均通过，独立增量代码审查未发现可行动问题。本轮 e2e 继续由用户复测，重点增加首次文件选择取消、已选文件后取消和重选同一文件；首轮验证边界仍适用。未新增依赖或触及 TBD。

### 提交前流程审查与收口

实现提交：`ab438ad`。用户复测后表示基本满意，未再报告阻塞性问题，并要求提交前审查流程。

两条独立只读审查分别核对完整导入路径，以及共享表单／弹窗兼容性、文档和测试证据，均未发现可行动问题或提交阻塞。审查覆盖文件取消与重选、已有／新来源、返回与 Escape、创建与导入的等待／失败／成功、关闭后迟到回调及重新打开。来源目录创建和来源编辑的默认参数、取消语义与 API 契约保持兼容；关闭后缓存仍可刷新，旧组件的挂载标志和定时器清理阻止迟到导航。

提交前重新执行 `just check`，lint、后端 286 项与前端 197 项测试、生产构建及 53 份文档／495 个本地链接检查全部通过；暂存内容的 `git diff --cached --check` 通过。生产主包仍有既有体积提示。

本轮未追加代理浏览器操作。用户使用反馈与工程检查分别记录；现有自动化回归覆盖取消事件边界，未覆盖完整 React 异步交互及跨浏览器的原生文件选择器行为。
