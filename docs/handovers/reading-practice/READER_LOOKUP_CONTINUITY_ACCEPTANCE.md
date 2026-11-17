# 查词连续性与键盘滚动验收

日期：2026-11-17。改动起点：`main b89189ab`，验证对象为 `codex/reader-lookup-continuity` 分支。范围为查词辅助选项原位刷新、真实悬浮的焦点与动效、方向键排版步长。现行行为见 [PRD](../../PRD.md#epub-即时查词)、[即时查词交互](../../INFORMATION_ARCHITECTURE.md#即时查词)和[阅读外观与工具显隐](../../INFORMATION_ARCHITECTURE.md#阅读外观与工具显隐)，请求与高亮协调见[架构](../../ARCHITECTURE.md#即时查词与词典管理)。

## 实现取舍

复用已有查询路径，根卡身份与请求票据分开，刷新通过原高亮回调更新范围。等待期间保留旧内容的布局尺寸并隐藏，避免卡片先收缩再展开；悬浮手势显式传入，沿用现有焦点与动效入口。新增字段只描述临时手势、撤下高亮和刷新／重试状态，无新依赖、服务端接口、数据库迁移或 TBD。

## 回归与检查

[查词浏览器回归](../../../frontend/browser-tests/reader-dictionary.tsx)验证原文范围高亮、根卡位置、子卡清理、焦点、请求配置与迟到隔离；[片段查词回归](../../../frontend/browser-tests/segment-dictionary.tsx)覆盖共享入口；[阅读设置回归](../../../frontend/browser-tests/reader-settings.tsx)在实际 Reader 中验证排版变化后的滚动距离。

| 检查 | 结果 |
| --- | --- |
| 阅读设置浏览器回归 | 6/6，通过 1280／390／320px、明暗纸面与横竖排；12px × 1、40px × 3、26px × 2 下往返滚动分别为 18、180、78px |
| `?suite=reader-dictionary` | 5/5，通过 1280／900／740／390／320px，含桌面等待根卡、窄屏受约束词卡组的刷新定位 |
| `?suite=reader-dictionary&scene=selection` | 2/2，通过桌面及窄屏的主动选区查词 |
| `?suite=reader-dictionary&scene=selection-lifecycle` | 1/1，通过词典准备、改选、关闭与迟到查询隔离 |
| `?suite=reader-dictionary&scene=options` | 3/3，通过 1280×900、320×320、640×360；输出并目视检查设置截图 |
| `?suite=segment-dictionary` | 3/3，通过桌面及窄屏的快速切换、乱序响应、关闭、503 失败重试和真实悬浮 |
| `?suite=segment-dictionary&scene=dialog` | 2/2，通过完整资料弹窗的焦点、嵌套和清理 |
| `?suite=segment-dictionary&scene=lifecycle` | 1/1，通过片段保活、设置往返与同字悬浮恢复 |
| `just lint`、`just test`、`just build` | 全部通过；后端 1552 通过、3 跳过，前端 831 通过；提交前精简后重跑 `just lint`、`just test` 及片段查词 3 场，全部通过 |
| `just check-docs`、`git diff --check` | 公共本地路径与差异空白检查通过；未核验私有历史证据 |

浏览器精确查询使用 `BROWSER_TEST_QUERY='…' just test-browser`；阅读设置使用 `BROWSER_TEST_SUITE=reader-settings just test-browser`。共 23 个定向场景通过。设置截图由 `BROWSER_TEST_SCREENSHOT_DIR` 输出到临时目录，不作为长期资产。

## 浏览器观察与限制

主代理实际打开合成阅读页，点击正文后观察到贴近原字的根词卡、原文高亮及卡头焦点。自动化真实 Chrome 操作验证切换选项时根卡 DOM 与位置不变、菜单继续可用，新范围高亮更新，真实 Shift 悬浮保留焦点且无入场动画。桌面与 320×320、640×360 设置截图已目视检查：开关、关闭入口和辅助说明可读，短视口内容可滚动。

静态审查修复了窄屏子卡撑高后的回跳，以及桌面等待首个结果时刷新的重新定位，两项均有浏览器坐标回归。提交前审查移除重复的隐藏交互限制，将重试回调设为必传，并精简本记录的重复规则。

所有回归使用本机隔离浏览器与合成响应，不访问日常学习库或真实模型。实体触屏、Safari／Firefox、Windows 实机和真实词典全量兼容性未在本轮重验；触屏回归只验证模拟手势路径。
