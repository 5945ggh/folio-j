# EPUB 切片 0 阅读实验

独立试验界面，不接生产路由、数据库、模型或第三方阅读器。使用现有 Vite，无新增依赖。

在仓库根目录启动：

```sh
frontend/node_modules/.bin/vite prototypes/epub-reading --host 127.0.0.1 --port 5178
```

打开终端显示的本地地址。选择内置样书，或通过「打开本地编译 JSON」读取 `epub-spike-v1` 文件。内置样书列表来自 `public/books/index.json`，数组项为 `{ "title": "标题", "path": "./books/文件.json" }`。编译与样书生成说明见样书目录和阶段交接文档。

## 操作与验收

1. 选择资源章节，切换横排／竖排滚动、作者 CSS 和字号。
2. 在正文划选，点「捕获选区」。右栏显示材料版本、资源身份、NFC 正文码点半开范围、原文快照及前后文。
3. 调整字号、布局后点「校验并还原选区」，应回到相同正文。选区原始 DOM 字符串可能包含 ruby 注音或分解字符；引用快照使用定位正文。
4. 修改右栏 JSON 的版本、资源或 exact，再恢复应明确拒绝；不会搜索另一处相同文字。
5. 点「运行真实 DOM 自检」查看 11 项逐项结果。实际 iframe Range 覆盖 ruby、跨节点 NFC、emoji、重复文字、字号布局、版本／资源／快照／投影失配、重复叶子交换及隐藏正文。此按钮的结果是浏览器运行证据，不以 Node 测试替代。

纯逻辑测试与语法验证：

```sh
node --test prototypes/epub-reading/locator.test.mjs
node --check prototypes/epub-reading/app.mjs
```

## 工程边界

- 定位仅支持当前已加载的单资源；未实现跨章节引用、分页、进度持久化、学习内容写入。
- 受控正文叶子全局串接后 NFC，拒绝代理对内部和不可分离 NFC 组合边界。反向定位只使用可验证的 raw 边界。
- 恢复核对版本、资源、码点范围、原文快照、DOM 正文投影及连续唯一的叶子编号顺序，恢复后再捕获核对往返。作者 CSS 若隐藏被引用正文，拒绝创建或恢复可见引用。
- 书籍置于无脚本的 sandbox iframe；静态 srcdoc CSP 限制为内联样式、data 图片和字体。正文剥除可执行／交互元素及事件、链接、内联样式；作者 CSS 以 style.textContent 注入，内容不拼接进 srcdoc。外部图片和资源请求不获准。
- 原 CSS 仅在 iframe 内参与样例对照，不代表全面保留 EPUB 样式的产品承诺。图片限受控 data PNG/JPEG/GIF/WebP。编译器支持将 EPUB 的纯图片 SVG 包壳转换为受控图片；这不表示支持通用 SVG 图形、脚本或交互。阅读 iframe 不直接接纳 SVG 元素。
- 实际 DOM 文字允许普通浏览器扫描；未运行 Yomitan 扩展验收，不宣称兼容。
- 对已是 NFC 的章节，反向查找只做一次码点扫描；分解正文使用原生 Intl.Segmenter，并校验分段 NFC 串接与全局 NFC 一致，再验证目标边界。不自建 Unicode 算法。长文回归测试覆盖 48k 码点 NFC 与 44k 码点加跨节点分解组合；不是全面性能基准。
