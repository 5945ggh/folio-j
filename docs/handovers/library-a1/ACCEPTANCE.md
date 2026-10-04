# 素材库 A.1 集成验收记录

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
- 已留存[空库](../../../temp/library-a1-acceptance/evidence/empty-wide.jpg)、[两本真实封面](../../../temp/library-a1-acceptance/evidence/two-real-covers-wide.jpg)、[菜单失败](../../../temp/library-a1-acceptance/evidence/status-failure-menu.jpg)、[无结果](../../../temp/library-a1-acceptance/evidence/no-results.jpg)、[旧缓存重建](../../../temp/library-a1-acceptance/evidence/old-cache-rebuilt.jpg)与[阅读器回归](../../../temp/library-a1-acceptance/evidence/reader-regression.jpg)截图。

真实样书与参考封面只留用户本机，不放公开仓库或站点。用户原日常库仅进行只读调查，未迁移；独立测试库验证迁移与重建，无删库重导。

封面调查见[本机后端报告](../../../temp/library-a1-acceptance/COVER_REPORT.md)，不变式核对见[旧缓存验证 JSON](../../../temp/library-a1-acceptance/old-cache-verification.json)。以上 `temp/` 证据为 gitignored 本机文件；不随公开仓库分发，仓库读者可能无法访问。综合命令输出由主代理工具执行确认，未另存日志文件。

## 补充浏览器验收与限制

最终生产构建在独立验收入口 8773 验证以下行为：

- 55 本书分页为首 50 本／末 5 本，最近打开／降序与搜索条件可见；有书但筛选零结果显示无匹配和清除入口，无整区空库导入。目录 503 时先显示加载再显示错误／重试，从未冒充空库，故障解除后重试成功。见[多页窄屏](../../../temp/library-a1-acceptance/evidence/pagination-narrow.jpg)、[目录失败](../../../temp/library-a1-acceptance/evidence/catalog-failure.jpg)。
- 320px 下长混合标题保持两行（实测高 44.8px）及完整 `title`，文档宽 320px 无横向溢出；390px 卡片大小 280 时单列、140 时双列，实测卡片宽度分别准确。见[长标题](../../../temp/library-a1-acceptance/evidence/long-title-320.jpg)、[真实封面窄屏](../../../temp/library-a1-acceptance/evidence/two-real-covers-narrow.jpg)。
- Source 保留原主从结构和三视图，共享书卡显示真实图片，1280px 无横向溢出；菜单 End 聚焦末项，Escape 返回触发按钮。见[来源页回归](../../../temp/library-a1-acceptance/evidence/source-regression-wide.jpg)。本轮只同步共享书卡与导航命名／图标，Source 页面风格可继续独立设计。
- Reader 图文、章节与工具沿用原布局可用，阅读返回保留 `q`／`sort`／`order`；目录滚动从 1392px 打开书再返回仍为 1392px。见[滚动返回](../../../temp/library-a1-acceptance/evidence/scroll-return.jpg)。Reader 风格可继续独立设计。
- Segment 确切历史修订 `65KCPG` 定位准确，390px 无溢出，讨论草稿收起重开不丢，1280px 保持原布局；未调用真实模型。见[工作台宽屏](../../../temp/library-a1-acceptance/evidence/workbench-regression-wide.jpg)、[工作台窄屏](../../../temp/library-a1-acceptance/evidence/workbench-regression-narrow.jpg)。
- 封面临时 503 后显示占位；恢复服务并点击同卡片菜单“重试封面”，资源带 `?v=2&retry=1`，实际解码宽 1443px，无需刷新页面，验证旧失败状态可解除。

迟到导入测试从 A.1 加号提交延迟 3 秒的合成书后取消，路由始终保持 `/materials?type=book&sort=title&order=asc`，最终计数由 55 增至 56，迟到结果没有抢导航。临时运行入口为原型 8771、开发前端 5175／API 8772、生产验收 8773，这些地址不作为持久成果链接。

未触及新 TBD；全书进度、播放器、书架、删除／元信息编辑、Occurrence 等未来功能不在本轮范围。结构校验不是完整图像解码，浏览器失败仍使用占位与重试。
