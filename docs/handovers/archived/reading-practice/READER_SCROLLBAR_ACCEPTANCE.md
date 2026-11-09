# 横排章末裁剪修复验收

2026-11-09，实施起点为 `main b48fe34d`，工作分支为 `codex/reader-scrollbar-clipping`。本记录维护复现条件、验证结果和适配边界；布局实现见[架构](../../../ARCHITECTURE.md)，页面行为见[阅读与导航](../../../INFORMATION_ARCHITECTURE.md#阅读外观与工具显隐)。

## 原因与修复

用户提供的私有 EPUB 在占宽滚动条下可复现横排末尾缺失。iframe 临时缩至 1px 测量内容高度时，外层滚动条消失，正文变宽；赋予测得高度后滚动条重新出现，正文变窄并增加换行，但 iframe 没有同步增高。裁剪后的正文边界仍可触发章内 100%。浮动滚动条不占宽，本机默认设置下不易复现。

原书对照中，iframe 测得高度为 10434px，最终正文需要 10511px，末段底边为 10488.23px。预留稳定滚动条槽后，iframe 高度为 10511px，正文完整。原书和截图未加入公共测试资产。

仅在横排 `.reader-viewport` 设置 `scrollbar-gutter: stable`，让测量与最终呈现使用相同宽度。短章沿用稳定宽度，竖排不预留侧边槽；不新增状态、依赖、数据库迁移或 TBD。

## 回归验证

浏览器使用 macOS 上的 Chrome 156.0.8078.81。新增[浏览器回归](../../../../frontend/browser-tests/reader-scrollbar.tsx)使用合成正文，局部重置 `scrollbar-width`／`scrollbar-color` 并设置传统滚动条宽度，使 macOS 上也实际占宽；断言直接检查文字矩形、滚动极限和阅读锚点。

| 检查 | 结果 |
| --- | --- |
| 短章 | 实际保留滚动条槽；无多余滚动空尾，与长章正文宽度相同 |
| 长单 iframe | 每个原文字行都落在 iframe 内；滚动到底能看到末尾；真实 Aa 横→竖→横保留原文锚点、iframe 与 Document 身份，无错误轴溢出 |
| 三 iframe 临界溢出 | 各 part 在测量宽度占四行、滚动条出现后占五行；整体可读高度为十二行减 1px；每个 part 尾部完整，真实滚动极限可见末尾 |
| 新增 suite | `BROWSER_TEST_SUITE=reader-scrollbar just test-browser`：1280×900、390×900，2/2 通过；截图复核两尺寸末行完整、正文与工具栏无重叠 |
| 既有方向切换 | `BROWSER_TEST_SUITE=reader-layout-switch just test-browser`：两尺寸、横排／竖排两种起始方向，4/4 通过；覆盖多 iframe、中点锚点、字号与宽度变化、页边标记和重复恢复默认 |
| 原书复核 | 使用最终阅读器样式与原书编译章节，横排 iframe／正文均为 10511px；竖排 iframe／正文均为 9304×1212px，末段均位于 iframe 内 |
| 工程检查 | `just lint`、`just test`、`just build`、`just check-docs`、`git diff --check` 通过；后端 1507 passed、4 skipped，前端 826 passed |

临时移除 gutter 的负向检查中，长 iframe 末尾文字超框 649px，多 iframe 独立用例末尾超框 33px，均由文字矩形断言检出。负向检查保持修复版的多帧输入宽度基准；完成后精确恢复生产 CSS 与正常断言，不保留测试开关。

独立工作区复用已安装依赖，工程命令通过 `PYTHONPATH=<工作区>/backend/src UV_NO_SYNC=1 UV_OFFLINE=1` 指定本工作区源码并跳过环境重装。完整后端测试在允许本机 socketpair 的执行环境运行，真实网络仍由测试守卫禁用。

新增 suite 每尺寸记录一次 `ResizeObserver loop completed with undelivered notifications` 提示，布局、锚点保存与全部几何断言随后完成。Windows 实机、Safari／Firefox 和完整浏览器矩阵未在本轮执行。

## 作者裁剪的适配边界

本轮保留作者的固定高度、最大高度和 `overflow:hidden/clip`。相同样式也用于有意隐藏内容、图片裁切和分栏，仅凭正文溢出无法确定是否误裁剪。现有章末、查词命中、图片缩放和学习标记都使用作者裁剪后的可见几何，通用解除会改变这些行为。既有[可见范围规则](../../../ARCHITECTURE.md#31-实体)与[作者裁剪回归](../../../../frontend/src/materials/dom.test.ts)继续适用。具体书籍的错误裁剪需独立样例和适配决策。
