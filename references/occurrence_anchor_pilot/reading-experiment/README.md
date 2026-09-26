# Occurrence 阅读视图实验

独立于产品代码的本地静态 demo。使用 batch-01 的四条既有 Occurrence（`sample01-o11`、`sample04-o03`、`sample05-o05`、`sample04-o04`）及其解析快照，不修改原始数据，不调用模型。

## 启动

在仓库根目录运行：

```bash
python3 -m http.server 8000 --bind 127.0.0.1 --directory references/occurrence_anchor_pilot/reading-experiment
```

浏览器打开 `http://127.0.0.1:8000/index.html`。`data.json` 已生成，浏览 demo 不需安装依赖或重建数据。浏览器需支持现代 ES modules。

如 batch-01 输入发生变化，先运行：

```bash
node references/occurrence_anchor_pilot/reading-experiment/build.mjs
node references/occurrence_anchor_pilot/reading-experiment/parser-test.mjs
```

`build.mjs` 使用本目录 `vendor/marked.esm.js`（Marked 17.0.5，MIT，许可文本见 `vendor/LICENSE.md`）确定性解析 Markdown。它从清单、JSONL 和快照建立 `data.json`；Section 原文和生成后的树同时保存，节点含原 Section 行号。前端不在浏览时向外部服务请求资源。

## 三种视图

- **当前基线**：目标原文、Surface 高亮、现有标题和 gloss。
- **原 Section**：同样的目标原文，加上直接展开的原 Markdown 讲解；按原 Section 顺序显示。
- **JSON 树**：同样的目标原文，加上从 Markdown 树逐节点渲染的讲解。标题导航及紧凑排版只基于文档结构，不自动给引用或列表赋予“例句”“推导”等语义。

多个 Section 保留独立标题和行号。可展开/折叠长内容；折叠不删除数据。对比、例句和不确定性说明均取自第一阶段解析。
