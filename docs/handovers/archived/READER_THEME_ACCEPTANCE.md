# UI 深浅主题适配验收

> 日期：2026-10-24。代码起点：`fb5ea8a`；正文主题修复已提交 `bd96835`，控件配色与浏览器回归已提交 `da0f729`。

## 范围与实现

公共页面保持浅色，Reader 独立使用白纸面、黑纸面或跟随系统。没有新增主题设置、依赖或后端契约，也没有触及 TBD。

本轮修复六类问题：

1. Reader 内的放弃草稿、选用已有片段确认框使用阅读器背景、文字和原生控件配色。
2. EPUB iframe 在作者样式之前声明主题级联层，以 `!important` 控制正文前景、背景、背景图片、文字填充和阴影。字体及 ruby 规则沿用原有位置；定位文本与图片不改写。
3. 原处讲解预览中的行内代码、代码块和引用块使用 Reader 主题变量。
4. Reader 内错误提示按纸面分别使用错误文字色。
5. 目录及阅读选项按纸面设置选中背景和文字，当前章节进度继承选中文字色。
6. 加深浅色阅读器说明、公共页面辅助文字、素材库数量和讨论状态，保留辅助信息的层次。

## 验证方法

主题浏览器回归使用真实组件、模拟 API 和隔离 Chrome，覆盖桌面与窄屏、系统深浅偏好及 Reader 双主题。按实际渲染颜色与所在背景计算文字对比度；正文验证经过 `partDocument` 和 `applyFramePresentation`，包括作者选择器、具名层、渐变背景、文字填充及阴影。

## 验证结果

- `just lint`：Ruff、pyright、Biome、TypeScript 与原型语法检查通过。
- `just test`：后端 610 项、前端 447 项测试通过。
- `just test-browser`：24 个浏览器场景通过，包含已有阅读、翻译、本章记录和讨论回归。
- `BROWSER_TEST_SUITE=theme just test-browser`：1280／320px × 系统浅色／深色四场景通过；每个场景同时检查 Reader 白／黑纸面，受测普通文字最低实际对比度为 4.67:1。
- `just build`：构建通过，保留现有大于 500 kB 的 JavaScript chunk 提示。
- `just check-docs` 与 `git diff --check`：通过。
- 独立审查：样式作用域、首级联层、EPUB 清洗契约和浏览器测试覆盖未发现阻塞项。

主题单元回归先捕获首层缺失，再验证修复。浏览器回归首跑还捕获表单说明 `field-help` 的 4.31:1 对比度，统一辅助文字色后通过。首层优先级依据 [CSS Cascade 5](https://www.w3.org/TR/css-cascade-5/#layer-order) 的重要声明层顺序。

实际截图复核：黑纸面的确认框已显示深色背景、清楚的标题及两个按钮；白纸面的同一确认框保持浅色。讲解预览的行内代码、代码块、引用及表格可读，引用块不再残留白底；目录当前章节的进度与标题使用同一选中文字色。证据见[深色确认框](evidence/reader-theme/folio-theme-fixed-dialog-dark.png)、[浅色确认框](evidence/reader-theme/folio-theme-fixed-dialog-light.png)、[深色讲解预览](evidence/reader-theme/folio-theme-fixed-markdown-dark.png)和[深色目录进度](evidence/reader-theme/folio-theme-fixed-toc-dark.png)。

## 验证边界

浏览器验证覆盖 Chromium。Safari、Firefox、实体触屏和任意 EPUB 作者样式的穷举验证尚未进行；图片保留原始配色。
