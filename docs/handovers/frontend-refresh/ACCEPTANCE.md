# 前端调整验收记录

> 2026-10-04；本轮 A–E 已完成。以下为实现代理与主代理本轮命令、独立数据库、真实浏览器及离线工具执行证据；不以旧 EPUB 记录或参考图代替本轮验收。

代码范围已分两本地提交：`e1ca96f`（后端与生成契约）、`0c82ac1`（前端及最终 CR 修复）；文档单独收口。8766 演示服务使用独立测试库与离线模型响应，主代理实际测试的是最终生产构建；用户日常数据完全未迁移。

## 命令与审查

| 命令 | 结果 |
| --- | --- |
| just gen-api | 通过，生成 OpenAPI 与客户端同步 |
| just lint | 通过 |
| just test | 通过：后端 233、前端 51、实验 4，合计 288 |
| just build | 通过；主 JS 包 600.92 kB，保留超过 500 kB 的构建提示 |
| just check-docs | 主代理综合通过；文档收口复查通过：38 份文档、310 个本地链接 |
| git diff --check | 主代理综合通过，文档收口复查通过 |

独立交叉 CR 已完成：后端↔阅读器、阅读器→目录。发现并修复静态封面支持限制、700／720px 响应式边界、Source 概览滚动恢复、新导入反馈、嵌套 main。审查和通过测试不证明所有 EPUB、扩展配置或真实模型教学质量。

## 查询、数据与状态

| 范围 | 本轮证据与结果 |
| --- | --- |
| 空／旧库迁移 | 0008_material_usage 测试通过，保留旧原书字节、产物、ID、位置；新表按有效位置保守初始化，历史打开时间为空，不推断完成 |
| 目录 | 完整结果筛选／排序／分页、真实计数、最近打开空值双向置后及 Source 删除门禁由后端离线测试覆盖；真实页面展示书籍、三视图和封面／占位 |
| 手工状态 | 设未开始后展开阅读设置不被本次 opened 覆盖；完成后再次打开保持完成；显式 usage 503 时卡片保留旧值并报错，解除故障后重试成功 |
| 打开竞争 | 状态版本、重复动作、迟到打开、删除门禁与独立位置 revision 由离线测试覆盖；实际进入章节后记录打开，页面状态刷新不重置阅读器 |
| 新导入与复用 | 新 Source 上传合成 EPUB 成功并显示新导入；同 Source 重复导入返回同 ID、复用提示，已完成和位置 27% 保持 |
| 导入失败 | 异常 EPUB 在新 Source 创建后报错，Source 保留、可重试，未出现可读半本书 |
| 迟到导入 | POST 延迟 4 秒后取消窗口，始终留原 materials?q 长文条件；迟到成功刷新列表 1→2 项，没有强制导航，新材料仍未开始 |
| 跨 Source 身份 | 同合成 EPUB 导入另一个 Source 得到独立 ID，未合并领域身份 |

## 浏览器与阅读回归

本轮先使用 Vite，再使用最终生产构建（8766）真实操作；数据库隔离为 `temp/frontend-refresh-acceptance/app.db`。界面覆盖 1440×900、1280×800、1024 宽及 390×844，补验 710×800 阅读页无页面横向溢出；正文自己的竖排横向滚动保留。

| 路径 | 实际观察 |
| --- | --- |
| Source 窗口→阅读→返回 | 回同一 Source 展开窗口；直接 expanded URL 刷新保留 q，Escape 回同 Source，正常展开后 back 先关闭窗口 |
| Source 概览→阅读→返回 | P2 修复后窄屏 scrollY 718.5→阅读→返回仍 718.5 |
| 长文重排／立即离开重开 | 合成长文 160 段，从第 40／41 段经历 1440→1024→390、侧栏宽窄、字号 20→22、横排→竖排，重开仍第 40 附近；数据库同 offset 2419 恢复，材料版本及资源身份未变 |
| 历史修订直达 | 实际打开对应历史 revision，未静默转成当前版本 |
| 本页讨论草稿 | 回讨论列表、收起再打开后保留；审核附加草稿同样保留 |
| 问答／审核 | 普通问答不创建讲解；同意产生新 revision；拒绝保持 current_revision 不变 |
| 迟到成果 | 延时生成期间回列表，完成不抢阅读焦点，成果仍可访问 |
| 停止及失败成果 | stop 显示已中断；生成后失败仍有保存成功 revision 入口，不把失败抹成无成果 |
| 设置与生产页面 | 窄屏设置及生产构建导航／阅读真实打开；现有模型用途、验证及诊断协议保持，未接真实外部模型 |

工具链路用离线模型响应执行真实本地业务／保存／审核路径；不访问真实模型或外网。分页、状态竞争与异常资源的正确性证据主要来自针对性离线测试；上述长文观察不外推为任意 EPUB 精确恢复保证，模态的每一种辅助技术配置未逐一验证。

## 本轮真实截图

截图位于隔离验收目录，合成内容不冒充用户真实书库；临时文件保留在本地，不保证随公开仓库分发。

- [最终生产素材库](../../../temp/frontend-refresh-acceptance/evidence/materials-final-wide.jpg)
- [素材库宽屏](../../../temp/frontend-refresh-acceptance/evidence/materials-wide.jpg)、[窄屏](../../../temp/frontend-refresh-acceptance/evidence/materials-narrow.jpg)
- [Source 素材](../../../temp/frontend-refresh-acceptance/evidence/source-materials-wide.jpg)、[片段](../../../temp/frontend-refresh-acceptance/evidence/source-segments-wide.jpg)、[讲解宽屏](../../../temp/frontend-refresh-acceptance/evidence/source-analyses-wide.jpg)、[讲解窄屏](../../../temp/frontend-refresh-acceptance/evidence/source-analyses-narrow.jpg)
- [展开窗口宽屏](../../../temp/frontend-refresh-acceptance/evidence/source-window-wide.jpg)、[窄屏](../../../temp/frontend-refresh-acceptance/evidence/source-window-narrow.jpg)、[设置窄屏](../../../temp/frontend-refresh-acceptance/evidence/settings-narrow.jpg)
- [阅读竖排重排](../../../temp/frontend-refresh-acceptance/evidence/reader-vertical-reflow.jpg)、[窄屏恢复](../../../temp/frontend-refresh-acceptance/evidence/reader-narrow-restored.jpg)、[复用与完成](../../../temp/frontend-refresh-acceptance/evidence/reader-reused-completed.jpg)
- [历史讲解](../../../temp/frontend-refresh-acceptance/evidence/workbench-historical-wide.jpg)、[审核](../../../temp/frontend-refresh-acceptance/evidence/workbench-review-wide.jpg)、[失败保留成果](../../../temp/frontend-refresh-acceptance/evidence/workbench-failure-with-artifact.jpg)、[工作台窄屏](../../../temp/frontend-refresh-acceptance/evidence/workbench-narrow.jpg)
- [导入失败保留 Source](../../../temp/frontend-refresh-acceptance/evidence/import-failure-preserves-source.jpg)

## 默认、迁移与限制

采用书籍网格、真实类型入口、书籍／Source／讲解标题升序、片段创建时间降序，每页 50／上限 100，概览最多 6 项。标题 NFC 后 SQLite BINARY 确定序，ID 升序破同值，最近打开空值双向置后，不承诺自然卷序／拼音序。宽屏侧栏记偏好、窄屏抽屉，URL 显式条件优先。具体接口见 [API.md](API.md)。

封面为本地 EPUB 明确声明的有界静态 PNG／JPEG，4 MiB、1600 万像素；APNG／GIF／WebP／SVG／异常占位，不新增图像解码依赖。未新增任何依赖。

日常库未迁移、未改数据，因此本轮不声称做过日常库备份。用户以后启用新 schema 前，应按 WAL 一致性要求备份（不能只复制正在写入的主 db），再执行 `just migrate`；`just dev`／`just start` 同样先迁移，启动前须明确数据库路径。

本轮未关闭任何 TBD，现有 Agent 权限、原文锁定与不可变修订不扩展。Occurrence、注音、选区学习、播放器、Lexeme、扫描、MCP、统一预处理与 FUTURE_NOTES 不执行。建议用户实际试用素材库筛选与封面、Source 窗口往返、长文与讨论对照；注音及选区学习保持后续独立切片。
