# EPUB 切片 0 样书来源

合成样书由本仓库原创测试文字构成，运行 `python3 scripts/make_epub_fixtures.py` 可逐字节重建。`synthetic-reading.epub` 包含两章节、ruby／rp、实体、块与 br 换行、重复句、跨节点浊点、𠮷与 ZWJ emoji、全角兼容字符与内嵌图片；vertical 变体加入作者竖排及绝对定位 CSS；malicious 变体加入脚本、iframe、事件属性、外部资源、路径逃逸图片与 hidden 内容；fixed 变体声明全书固定版，预期拒绝。

浏览器用 JSON 从这三本合成书生成：

```bash
UV_CACHE_DIR=.cache/uv uv run --project backend python scripts/epub_spike.py prototypes/epub-reading/fixtures/synthetic-reading.epub
UV_CACHE_DIR=.cache/uv uv run --project backend python scripts/epub_spike.py prototypes/epub-reading/fixtures/synthetic-vertical.epub
UV_CACHE_DIR=.cache/uv uv run --project backend python scripts/epub_spike.py prototypes/epub-reading/fixtures/synthetic-malicious.epub
```

## 本机真实出版物（内容与生成全文均不提交）

2026-10-03 只读检查了以下本机素材；第8卷采用用户提供的本仓库 temp 副本（SHA-256 与 LearningJ 副本相同）；元数据及完整章节结构表明它们是真实商业出版物，未获得重新分发许可，因此 EPUB、图片及生成全文仅在本机使用。JSON 放在 gitignore 的 `public/books/local/`，索引保留入口；其他机器未生成时会显示加载失败。

| 路径 | 元数据／特征 | 字节与 SHA-256 |
| --- | --- | --- |
| `/Users/ningcc/Products/LearningJ/temp/安達としまむら1.epub` | 标题安達としまむら，入間人間，株式会社ＫＡＤＯＫＡＷＡ，标识04891421A03870000000。全书 reflowable，若干封面／插图 spine 项声明固定页，其 XHTML 是 SVG 包裹单张本地 raster 图片。 | 13411714；`f9fdf1b32583660563c7f74bc04f2792567ae094473406332f309dbc03ad20eb` |
| `/Users/ningcc/Products/folio-j/temp/安達としまむら8.epub` | 标题安達としまむら8，入間 人間，株式会社ＫＡＤＯＫＡＷＡ，ASIN B07R3GSDN7。24个 spine 资源，竖排作者CSS、ruby、图片及分章节正文；无全书固定版声明。 | 3916746；`66bc139a11eb6f89d96db9e41806cf57cfd2faf2b5e89b2fee9f44c375e95a68` |

```bash
UV_CACHE_DIR=.cache/uv uv run --project backend python scripts/epub_spike.py '/Users/ningcc/Products/LearningJ/temp/安達としまむら1.epub' --output prototypes/epub-reading/public/books/local/adachi-1.json
UV_CACHE_DIR=.cache/uv uv run --project backend python scripts/epub_spike.py '/Users/ningcc/Products/folio-j/temp/安達としまむら8.epub' --output prototypes/epub-reading/public/books/local/adachi-8.json
```

LearningJ 的 `docs/phases/reader-foundation/references/epub-research/learningj-epub-spike/sample.epub` 是旧试验合成书（title LearningJ EPUB Spike／identifier urn:learningj:spike），不能充当真实书验收证据。
