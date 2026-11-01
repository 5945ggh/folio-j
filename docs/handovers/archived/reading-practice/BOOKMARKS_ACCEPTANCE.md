# 位置书签验收

> 2026-10-29 实施，2026-10-30 验证；基于 `main 7d57239` 的 `codex/reader-bookmarks` 独立工作区。实现、工程检查、定向浏览器及独立审查完成，书签提交 `11ab6bb` 已与阅读设置集成到本地 main；现用库已升级，卡片调整与备份核对见下方追加记录。

## 范围

工具栏保存点击时已呈现的原文或图片位置，成功轻提示并提供备注入口；左侧书内导航增加书签页，按书中顺序展示、编辑备注、删除和跳转，沿用临时返回点。摘要固定为前 40／后 120 码点上限，不增加设置。用户确认删除书籍后保留书签、摘要和备注，随材料隐藏且不向重导材料换绑。

本轮不扩展搜索，不加入精确批注、常驻高亮或页边书签。产品规则见 [PRD 4.9](../../../PRD.md#49-阅读摘录书签与记录检索)，数据及接口见[架构](../../../ARCHITECTURE.md#315-位置书签)，操作见[使用指南](../../../USAGE.md#目录搜索与书签)。

## 工程检查

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `just test` | 后端 916 passed、1 skipped；前端 670 passed | [日志](../../../../data/acceptance-evidence/reader-bookmarks-20261030/test.log) |
| `just lint` | Ruff、pyright、Biome、TypeScript 与原型语法检查通过 | [日志](../../../../data/acceptance-evidence/reader-bookmarks-20261030/lint.log) |
| `just build` | 生产构建通过 | [日志](../../../../data/acceptance-evidence/reader-bookmarks-20261030/build.log) |
| `just check-docs`、`git diff --check` | 本地路径链接与 diff 格式通过；新增标题锚点另行核对 | [链接日志](../../../../data/acceptance-evidence/reader-bookmarks-20261030/docs.log) |

后端回归覆盖固定摘要预算、Unicode 规范化、同章跨 part 与章界、混合图片／正文排序、冻结请求重试、备注版本冲突、材料及 Source 删除门禁、计算后删除竞争、同字节重导不换绑。迁移覆盖空库建到 30 表、从 `0002_context_copy_settings` 增量升级保留旧表数据、重复升级、降级及 ORM 结构一致性。

纯前端测试覆盖位置快照、备注码点预算、清空也算编辑、查询刷新不覆盖草稿基线、旧保存完成保留后续修改，以及材料版本之间的草稿隔离。

验证使用隔离数据库、合成 EPUB 和离线接口夹具，不调用真实模型，不修改实际使用数据。独立工作区通过本机已有依赖和历史验收目录的局部链接运行；未将日常数据库链接到工作区。

## 浏览器与实际界面

`BROWSER_TEST_SUITE=position-bookmarks` 的最终 4 个场景通过：1280／390 宽度 × 横排／竖排。系统主题在该 Chrome 环境中解析为黑色，截图分别为[宽横排](../../../../data/acceptance-evidence/reader-bookmarks-20261030/wide-horizontal.png)、[窄横排](../../../../data/acceptance-evidence/reader-bookmarks-20261030/narrow-horizontal.png)、[宽竖排](../../../../data/acceptance-evidence/reader-bookmarks-20261030/wide-vertical.png)、[窄竖排](../../../../data/acceptance-evidence/reader-bookmarks-20261030/narrow-vertical.png)。截图在面板入场结束后采集。

场景覆盖真实 Reader 入口的添加、请求期间滚动及失败重试保持首次位置与 UUID、快捷备注和 textarea 焦点、键盘页签切换、清空备注、503／409 保稿、关闭面板／切页签／切章保稿、失效查询隐藏旧缓存及重试恢复、列表顺序与重开、横竖切换后跳转与返回、图片位置、删除取消与确认。宽横排另覆盖从列表保存或删除刚创建的书签后清理旧成功提示。

父面板焦点修复后，补跑带上下文复制 4、导航反馈 5、整站／阅读器主题 4、既有页边学习记录 1，共 14 个场景全部通过，见[回归日志](../../../../data/acceptance-evidence/reader-bookmarks-20261030/reader-regressions.log)。主题场景最低对比度为 4.67:1。

主代理在应用内浏览器实际打开同一离线页面（1094px、白色横排），手动完成工具栏添加、快捷备注输入及保存；焦点进入备注框，保存后列表显示输入内容；再次添加后确认成功提示会自行收起。该观察使用真实生产组件与模拟后端，不等同于实际使用库上的操作。

## 审查与修复

独立只读审查核对持久化、迁移、请求冻结、删除门禁、排序、摘要、草稿生命周期和导航接入。审查发现创建提示持有旧 DTO：从列表编辑或删除新书签后仍可经提示打开旧内容；现已按书签身份清理对应提示，并补浏览器回归。删除成功改为按 ID 关闭编辑器，避免迟到回调关闭另一条备注。

浏览器回归发现快捷备注焦点被父面板抢走，已修复并覆盖。集成核对补齐查询失败后隐藏旧列表／计数／编辑器，草稿保留，避免已确认失效的材料继续展示缓存记录。

## 限制

备注草稿只在当前页面会话内保留，刷新页面前需保存。书籍删除后的书签暂不提供独立归档查看或恢复入口。实体触屏设备、成功提示暂停计时及朗读条同屏避让未单独自动化验证。白色窄屏卡片已人工核对，未单独加入自动化主题矩阵。备份操作见[升级与备份](../../../UPGRADING.md)。


## 2026-10-30 卡片呈现调整

用户要求书签以单角圆角卡片排列，由主代理直接设计和实现：右上角 20px 圆角，其余直角；细边框、浅底色及 12px 卡片间距。章节信息弱化，原文摘要提高到 14px，备注用轻侧线区别；编辑入口带笔形图标，删除收为保留名称与悬停提示的图标按钮。备注编辑框沿用同一外形，保存、删除、定位及数据规则不变，无新增依赖或 TBD。

`just lint`、`just test`（后端 916 passed、1 skipped；前端 670 passed）、`just build` 均通过，见[静态检查](../../../../data/acceptance-evidence/reader-bookmark-cards-20261030/lint.log)、[测试](../../../../data/acceptance-evidence/reader-bookmark-cards-20261030/test.log)、[构建](../../../../data/acceptance-evidence/reader-bookmark-cards-20261030/build.log)。

既有位置书签浏览器四场景重新运行，1280／390 × 横竖排全部通过，见[日志](../../../../data/acceptance-evidence/reader-bookmark-cards-20261030/browser.log)。主代理检查卡片截图，并在应用内浏览器亲自查看白色纸面 1280px、390px 的列表及窄屏备注编辑态：卡片边框和单角圆弧清楚，文字未横向溢出，编辑／删除保持可达，输入焦点正常。黑色场景截图为[宽横排](../../../../data/acceptance-evidence/reader-bookmark-cards-20261030/wide-horizontal.png)、[窄横排](../../../../data/acceptance-evidence/reader-bookmark-cards-20261030/narrow-horizontal.png)、[宽竖排](../../../../data/acceptance-evidence/reader-bookmark-cards-20261030/wide-vertical.png)、[窄竖排](../../../../data/acceptance-evidence/reader-bookmark-cards-20261030/narrow-vertical.png)。验证仍使用合成数据与离线接口夹具，没有向日常库写入测试书签。

## 2026-10-30 日常数据库升级

用户明确允许升级后，通过原工作区配置确认日常库为 `/Users/ningcc/Products/folio-j/data/app.db`，原 revision 为 `0002_context_copy_settings`。备份前和迁移前两次 `lsof` 均未发现数据库、WAL／SHM 或 worker lock 的打开句柄。

SQLite 备份 API 生成一致性副本，配套凭据、代码 HEAD 归档、工作区差异与新增源码分别备份；目录／文件权限限制为 0700／0600。私有备份位于 `~/Backups/folio-j/20261030-002320-before-bookmarks/`。库副本的逐表指纹、完整性、外键与凭据副本摘要核对通过后，在书签工作区显式设置日常库路径执行 `just migrate`。

实际库已升至 `0003_material_bookmarks`，只新增空的 `material_bookmarks` 表。原有 29 张业务表的数据逐行摘要及 schema 与备份一致，配套凭据摘要不变；完整性与外键检查通过。核对结果见[升级摘要](../../../../data/acceptance-evidence/reader-bookmark-cards-20261030/database-upgrade.json)。未启动日常后台服务或调用模型。

升级时书签代码仍在独立工作区，需要显式指定日常库。此阶段未复制日常配置或凭据目录，也没有把日常库设为测试数据库；原目录启动问题已在下方集成中解决。


## 2026-10-30 原目录集成

用户要求将书签改动集成回 `/Users/ningcc/Products/folio-j`。操作前保存全部 Git refs 的 bundle、书签工作区 diff 和新增文件，恢复快照位于私有 `data/acceptance-evidence/bookmark-integration-20261030/`。书签独立提交为 `11ab6bb`；原目录切到本地 main 并快进至阅读设置 `eaee221`，再合入书签。生产代码自动合并，只处理实施基线和阶段索引的文档冲突，双方功能与验收依据均保留；没有推送远端或删除独立 worktree。

整合后 `just lint`、`just test`（后端 917 passed，前端 698 passed）、`just build`、`just check-docs` 通过。全量后端出现一次 aiosqlite 连接线程在事件循环关闭后返回的警告；对应配置测试定向复核 53 项通过、未复现警告，结果保留在[复核日志](../../../../data/acceptance-evidence/bookmark-integration-20261030/warning-recheck.log)。工程结果见[静态检查](../../../../data/acceptance-evidence/bookmark-integration-20261030/lint.log)、[测试](../../../../data/acceptance-evidence/bookmark-integration-20261030/test.log)和[构建](../../../../data/acceptance-evidence/bookmark-integration-20261030/build.log)。

在整合代码上运行隔离浏览器，位置书签 4 场景及阅读设置 6 场景全部通过，覆盖横竖排、宽窄屏、备注／复制草稿与离开保护，见[浏览器日志](../../../../data/acceptance-evidence/bookmark-integration-20261030/browser.log)。

原目录的 `alembic current` 已识别 `0003_material_bookmarks (head)`，直接 `just migrate` 成功且无新增迁移。另以临时数据库实际运行 `just dev`，后端 `/api/health` 与 Vite 首页均返回 200，见[启动日志](../../../../data/acceptance-evidence/bookmark-integration-20261030/startup.log)。验证后停止本次创建的后端与前端进程；启动脚本收到重复终止信号时曾中断清理，已单独核实并停止遗留的验证前端进程。

现在可在原目录直接运行 `just dev`，默认使用原有 `data/app.db`，不再需要切到书签 worktree 或指定数据库环境变量。本轮集成没有改变日常学习数据，也没有新增依赖或 TBD。
