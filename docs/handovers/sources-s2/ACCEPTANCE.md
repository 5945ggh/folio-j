# 来源空间 S2 工程验收记录

日期：2026-10-05。状态：实现完成，本轮浏览器与独立 API 工程验收已完成；最终综合命令已通过。本记录不表示用户最终使用验收，也不继承原型或 A.1 的历史通过结论。

起点 `079b56f80d09e4d2abc66c1844f53d18713ffaa6`，起始分支 `codex/library-a1`、工作区干净，实施分支 `codex/sources-s2`。下列浏览器观察均由主代理实际执行并报告，文档／数据代理仅独立执行数据与 API 检查。

## 1. 当前基线与施工范围

完成来源三栏（主导航／来源列表／来源内容）、概览／素材／片段／讲解四视图；有界预览 2／3／3、来源每页 50 项且可访问后续页、普通来源身份核实、旧窗口链接兼容与真实来源管理。复用 A.1，Reader 与 Segment 工作台内部不重设计。长期规范已同步 PRD、信息架构、GLOSSARY，阶段入口与实施基线已关联本轮。

A.1 旧构建保留在本机 `temp/folio-s2-acceptance/baseline-dist`；对照截图为（宽屏在施工前采集，窄屏使用保留基线构建补录）[宽屏](../../../temp/folio-s2-acceptance/evidence/a1-before-wide.jpg)与[窄屏](../../../temp/folio-s2-acceptance/evidence/a1-before-narrow.jpg)。原型 35 项及旧生产验收保持各自历史身份。

## 2. 页面结构和操作范围

主代理验证三栏与四视图、紧凑来源标题及菜单，来源创建／编辑／信息全文、手动片段添加、当前来源固定导入均接真实业务。初始 65 来源第二页可达，390px 抽屉可跨页切源。无额外学习模型、统计或新书架。

截图：[概览宽屏](../../../temp/folio-s2-acceptance/evidence/overview-wide.jpg)、[来源抽屉](../../../temp/folio-s2-acceptance/evidence/source-drawer-narrow.jpg)、[片段 1024px](../../../temp/folio-s2-acceptance/evidence/segments-1024.jpg)。截图记录对应时刻的真实页面。

## 3. 概览内容与真实状态

独立 API 验证讲解 updated_at 降序返回 2／真实总数 6、片段 created_at 降序返回 3／真实总数 7、材料返回 3／真实总数 52；来源总数 65 分页 50／15。主代理验证概览讲解点击携带确切 revision，旧修订尾号 `DH4GFM` 显示历史版本而非跳当前。

仅手动片段、仅书、空来源与零来源已实际浏览；讲解区块 503 时其他区块继续显示，延迟切源后不串数据。单区故障截图：[讲解失败](../../../temp/folio-s2-acceptance/evidence/overview-partial-failure.jpg)。空态截图：[手动片段](../../../temp/folio-s2-acceptance/evidence/manual-only-narrow.jpg)、[空来源宽屏](../../../temp/folio-s2-acceptance/evidence/empty-source-wide.jpg)、[空来源窄屏](../../../temp/folio-s2-acceptance/evidence/empty-source-narrow.jpg)、[零来源](../../../temp/folio-s2-acceptance/evidence/zero-sources.jpg)。加载与错误分支同时有既有自动测试及代码核对，不声称每个端点都单独注入故障。

## 4. 默认进入与恢复场景

| 场景 | 本轮结果与证据口径 |
| --- | --- |
| 普通主导航进入 | 已验证：记忆有效来源＋概览，即使来源不在第一页 |
| 主动选择来源 | 已验证：打开新来源概览；390px 抽屉跨页切源 |
| 显式讲解／片段／素材视图 | 已验证：URL 与视图保持，未被概览默认抢占 |
| 浏览器后退／前进、当前路径刷新 | 已验证：精确保留 URL；讲解条件刷新保持 |
| 筛选讲解进入修订后返回 | 已验证：q=合成讲解、sort=updated_at、order=desc 保持，滚动恢复 472px；[截图](../../../temp/folio-s2-acceptance/evidence/filtered-analysis-return.jpg) |
| 概览讲解进入与返回 | 已验证：确切 revision 及概览入口；[修订入口](../../../temp/folio-s2-acceptance/evidence/explanation-exact.jpg) |
| 概览片段进入后原位置恢复 | 入口已验证；未单独报告该分支的滚动数值，不复用讲解 472px 结论 |
| 完整书籍窗口阅读后返回 | 已验证：q／排序／位置恢复，Escape 关闭后焦点回素材 tab；[截图](../../../temp/folio-s2-acceptance/evidence/book-window-return.jpg) |
| expanded=book 无 view 旧链接 | 已验证：兼容素材窗口背景及打开／关闭 |
| 素材库阅读返回 | 已验证 q=S2封面 进入阅读、选择第二章、返回条件保持、再次打开仍为第二章；全部排序／页码组合未逐项模拟，沿用既有测试 |
| 左侧来源搜索隐藏当前项 | 已验证：sq 无匹配仍保留原来源与 472px，左右检索隔离 |
| 记忆来源不在首批 | 已验证：按身份核实，不静默切源；65 来源可继续翻页 |
| 普通记忆来源失效 | 已验证：缓存普通入口后，仅删除本轮自建无内容的专用测试来源，再点主导航核实 404 并回有效首项；[截图](../../../temp/folio-s2-acceptance/evidence/invalid-memory-fallback.jpg) |
| 显式失效来源 | 已验证：显示不可用；[截图](../../../temp/folio-s2-acceptance/evidence/invalid-source.jpg) |
| 跨对象非法修订／讨论与外部 returnTo | 既有自动测试及校验静态核对，本轮未逐个浏览器伪造 |
| Storage 禁用或损坏记录 | try/catch 降级及参数校验静态核对；未实际浏览器禁用 Storage |

返回复用内部来处校验，不使用无条件 history.back()。旧 `/sources?q=…&sort=…&order=…&page=…` 来源总表链接也已验证迁移为来源栏条件；无效末页按真实总数降级。[兼容截图](../../../temp/folio-s2-acceptance/evidence/legacy-directory-query.jpg)。

旧历史修订截图：[历史版本](../../../temp/folio-s2-acceptance/evidence/historical-revision.jpg)。

## 5. CRUD、导入和持久化

主代理实际创建来源、编辑备注、读取来源信息全文、创建手动片段并回概览；当前来源固定导入合成 EPUB 后进入真实 Reader。来源删除显示真实影响，取消恢复焦点；影响 503 时确认禁用。保存 503 保留输入，延迟 3 秒提交取消再重开后，旧成功不关闭新表单或抢导航。截图：[删除影响](../../../temp/folio-s2-acceptance/evidence/delete-impact-narrow.jpg)、[影响失败](../../../temp/folio-s2-acceptance/evidence/impact-failure.jpg)、[保存失败](../../../temp/folio-s2-acceptance/evidence/create-failure.jpg)、[迟到成功保护](../../../temp/folio-s2-acceptance/evidence/late-create-protected.jpg)。另以延迟 3 秒合成 EPUB 验证提交后取消并切到片段视图：成功响应到达后仍停留原来源片段视图，无对话框或跳转；[截图](../../../temp/folio-s2-acceptance/evidence/late-import-protected.jpg)。

数据代理独立执行真实 localhost HTTP CRUD：仅自建专用来源，创建／编辑／手动片段成功；同源两次导入同一材料 ID，首次 reused=false、第二次 true；影响恰为 1 片段／1 材料、无线程／讲解／任务。删除只针对该临时记录，随后来源／片段／材料／目录读取均 404，原 fixture 来源响应一致。前后 Run 均为 0。未删除浏览器记录或日常数据。

## 6. A.1、Reader 与工作台回归

主代理验证 A.1 零素材整区入口 Enter 导入及取消焦点、搜索无结果、菜单状态 503 与重试成功／Escape 焦点。合成旧 fixture 无有效封面时占位正常；另用 valid-cover.epub 验证有效 PNG 回退，来源与素材库共用同一材料和 180×240 封面。封面逻辑生产代码未修改，本轮只做受影响回归，不重宣称完整提取安全测试。

截图：[A.1 当前宽屏](../../../temp/folio-s2-acceptance/evidence/a1-after-wide.jpg)、[空库入口](../../../temp/folio-s2-acceptance/evidence/a1-empty-regression.jpg)、[状态失败](../../../temp/folio-s2-acceptance/evidence/a1-status-failure.jpg)、[来源封面](../../../temp/folio-s2-acceptance/evidence/source-cover-regression.jpg)、[真实 Reader](../../../temp/folio-s2-acceptance/evidence/reader.jpg)。确切历史修订已浏览验证。讨论审核／停止／迟到成果等沿用既有自动测试，本轮没有重跑完整审核 UI 或模型教学；不扩张为真实模型质量验收。

## 7. 视觉、键盘、命令与交付

主代理实际检查 1440／1280／1024／390px 无横向溢出、窄屏来源切换、窗口 Escape 与取消焦点。概览窄屏截图见[本机证据](../../../temp/folio-s2-acceptance/evidence/overview-narrow.jpg)。补充截图：[窄屏讲解](../../../temp/folio-s2-acceptance/evidence/analyses-narrow.jpg)、[窄屏片段](../../../temp/folio-s2-acceptance/evidence/segments-narrow.jpg)、[窄屏书籍窗口](../../../temp/folio-s2-acceptance/evidence/window-narrow.jpg)、[A.1 当前窄屏](../../../temp/folio-s2-acceptance/evidence/a1-after-narrow.jpg)。没有逐个菜单穷举所有键盘组合，也不把源码语义核对冒充浏览器检查。

| 命令 | 执行者与结果 |
| --- | --- |
| seed_qa.py | 数据代理：独立空库迁移及合成 fixture 成功 |
| smoke_api.py | 数据代理：上述分页、预览、旧修订与 Run=0 通过 |
| crud_http.py | 数据代理：真实 HTTP CRUD／重复复用／删除隔离通过 |
| 脚本 py_compile | 数据代理：通过 |
| just check-docs | 文档代理：通过，最终收口后由主代理再次核对 |
| git diff --check | 文档代理：通过（收口后重新核对） |
| just lint／just test／just build | 主代理最终重跑：lint 通过；test 后端 244＋前端 57＋实验 4＝305 项通过；build 成功 |

生产主包 619.04 kB 的既有体积提示保留。无新依赖、schema 迁移、API 契约变化或新 TBD；未要求日常库迁移。

全部截图、样书、数据库、测试脚本与 JSON 证据在 gitignored 本机 `temp/folio-s2-acceptance/`，不随公开仓库分发。API 证据为 `api-evidence.json` 与 `crud-http-evidence.json`；ID 与导航路径见 `fixture-manifest.json`，不是私有书籍或真实模型录制。

手动复测：保留的独立服务 `http://127.0.0.1:8782/sources/01M45HA3DMG209G290SEDAEVJP?view=overview`，零来源入口 `http://127.0.0.1:8783/sources`。仅对应合成独立库，启动方式见本机 README。也可按正常开发入口 `just dev` 浏览现有本地应用；本轮没有启动日常库迁移、清空或重建。临时端口并非持久交付链接。

## 实际变更与复测

- `frontend/src/SourcePages.tsx`：三栏组合、普通入口身份核实、来源管理与表单代次保护；删除业务服务与权限规则沿用原实现。
- `catalog/SourceDirectory.tsx`、`SourceOverview.tsx`、`SourceViews.tsx`：来源栏、真实概览、四完整视图；复用 A.1 书卡与导入。
- `catalog/state.ts`、`hooks.ts` 与 `state.test.ts`：概览默认／旧链接兼容、左右查询与滚动作用域、回归用例。
- `catalog/sources-s2.css`、`source-content.css` 与 `main.tsx`：来源布局、响应式及独立样式加载。删除旧居中来源总表的重复呈现，未新增依赖、通用布局框架或数据层。
- 产品与导航、术语入口、实施基线和本轮交接文档同步；无新 TBD。

本轮命令运行环境：Node.js 24.14.0、pnpm 10.34.5、Python 3.11.14。API 契约没有变化，无需重新生成 DTO。

建议手动依次体验：来源概览 → 最近讲解 → 返回；讲解视图搜索 → 打开 → 返回；素材 → 查看全部 → 读书 → 返回窗口；来源栏搜索／翻页／切换；窄屏切换来源；来源菜单与添加片段。测试服务的模型适配器禁用，所有写入只进入独立合成库。

## 2026-10-07 提交前复核

代码起点为 `f459dd6`，本轮检查覆盖其上的 S2 前端提交候选。两位子代理分别审计界面实现与状态恢复。发现旧链接中显式空来源条件未覆盖旧条件，已修复并补充回归测试；测试先复现失败，修复后通过。复核未发现其他提交阻断问题。

`just lint`、`just test`、`just build`、`just check-docs` 和 `git diff --check` 通过。测试为后端 248、前端 77、定位实验 4，共 329 项。构建主包 659.27 kB，保留既有体积提示。

使用禁用模型与后台任务的独立合成库复测：1280px 概览与四视图正常；讲解进入确切修订后返回，搜索与排序条件及 712px 滚动位置恢复；390px 来源抽屉可翻页切源，手动片段可独立浏览，页面无横向溢出；书籍窗口进入阅读器后返回，搜索、排序、来源分页与窗口状态保留，Escape 关闭后焦点回到素材 tab。

本轮未新增依赖、API 契约、迁移或 TBD。用户使用验收待进行。

## 2026-10-15 来源界面调整复核

提交 `b1d6b91` 增加来源栏拖动／键盘调宽与本地宽度记忆，调整搜索展开、Escape 收起与空来源入口；公共导航补齐折叠提示和减少动态效果偏好。主代理审查实现，用户已说明本轮前端变动完成浏览器实测；本次提交审查沿用该结果。

来源栏宽度的 4 项纯逻辑测试通过，全量前端为 148 项、后端为 267 项；lint、生产构建、文档链接与差异检查通过。完整工程结果见[设置调整提交前复核](../settings-refresh/ACCEPTANCE.md#2026-10-15-提交前复核)。本次来源调整未新增依赖、API、迁移或 TBD。
