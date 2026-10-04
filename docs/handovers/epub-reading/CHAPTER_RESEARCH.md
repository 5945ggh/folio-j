# 逻辑章节、原书注音与阅读恢复调查

> 2026-10-03，切片 0 后用户反馈。只读调查 LearningJ 与用户提供的第 8 卷，并核实官方标准。本记录保存证据；负责规范为 PRD 4.7，下一切片实现边界见 [切片 1 草图](SLICE_1_DRAFT.md)。本轮没有新增拼章、分词注音或进度持久化代码。

## 用户决定与工程选择

用户明确要求：图文连续组织成阅读章节，章名直接显示原书目录名；原书振假名不被未来分词注音覆盖；按拼好的章记录阅读进度，字号／行距重排后尽力恢复附近位置。横竖排效果已认可，分页与恢复具体实现交由工程判断。

工程选择：先做横竖排滚动；目录决定导航标题及候选章边界，spine 决定资源顺序；恢复保存资源内锚点和逻辑章信息，百分比用于辅助显示。后续分页可复用该锚点，不以页号、像素或比例作为唯一持久位置。图片处使用其稳定资源位置及局部比例。阅读位置可近似，消息原文引用仍严格校验。

## 第 8 卷的实际目录与资源

输入为 `temp/安達としまむら8.epub`，字节摘要见[切片 0 验收](SLICE_0_ACCEPTANCE.md)。OPF 含 24 项 spine，nav TOC 与 NCX 的 7 项入口一致。以「遠路」为例：

| 原始 spine 顺序（0 起点） | 资源 | 内容形态 | 显示组织 |
| --- | --- | --- | --- |
| 8 | `OEBPS/Text/p-001.xhtml` | 图片章扉 | 「遠路」起点 |
| 9 | `OEBPS/Text/p-002.xhtml` | 正文及内嵌图片 | 连续归入「遠路」 |
| 10 | `OEBPS/Text/p-003.xhtml` | 下一章图片章扉 | 下一目录入口「最初の旅の端(1)」 |

这证明一项 spine 一个章节不适合该书，但不证明所有未列入目录的尾部资源都是小说正文。「帰路」目录入口之后、下一入口之前还有尾部附属资源，算法只能按出版物实际提供的边界分组；没有目录或语义标记时不能宣称准确推断作者未标明的章界。前置／尾部内容不得无提示丢弃。

## LearningJ 可借鉴的实现与局限

以下位置属于外部只读参考仓库 `/Users/ningcc/Products/LearningJ`，不是 Folio-J 的生产代码，也没有运行其完整测试：

| 位置 | 实际行为 | 本项目取舍 |
| --- | --- | --- |
| `backend/src/learningj/ingest/epub.py:955` | 连续纯图片资源可聚合；首图片出现在 TOC 时，再加紧接的一份正文；普通正文仍各自成章 | 借鉴资源／显示章分离，不照搬有限启发式 |
| 同文件 `:324`、`:863` | NCX 标签先加载，nav 标签覆盖；按资源路径索引并丢弃 fragment，nav 标签还包括 landmarks | 重新保留目录树、TOC 类型及 fragment；同一 XHTML 中多章要能表达 |
| 同文件 `:1000` | 拼接受控 HTML 时保留 `data-learningj-source-spine-index`，章记录 `source_indices` | 保留每份原资源范围与定位边界；不保存合并后的全章偏移作为引用身份 |
| 同文件 `:103`、`:619`、`:708` | 原 spine 正文独立，ruby base 进入正文，读音以资源内范围和 `reading_source=epub_ruby` 分离 | 未来自动注音按同一正文范围做独立显示数据，原书优先 |
| `frontend/src/features/reader/ControlledReadingSurface.tsx:212` | 使用原资源集合及显示章包含的索引创建 locator | 展示组织变化不能改变历史引用 |
| `backend/tests/test_epub_publication.py:202` | 覆盖章扉图片与正文聚为一章，并保留两份原 spine | 在本项目写对应回归，增加多正文资源、fragment 和嵌套目录情形 |

旧实现能聚合第 8 卷的 spine 8+9，但「帰路」只聚合 16+17，后面的 18／19／20 仍独立；它并未实现“目录起点之间的全部连续资源”。旧重建标签还会丢弃原 ID，不能因为链接带有 fragment 就视为片内跳转已经实现。未发现旧阅读面已实现分词自动注音 overlay 的证据。

Folio-J 当前试验的原书 ruby 呈现与正文排除规则已验证；未来任意 token 内包装仍需扩展适配器，不能把保留原书 ruby 误称为后补注音已经实现。

## 官方标准与工程推论的边界

- [EPUB 3.3 spine](https://www.w3.org/TR/epub-33/#sec-spine)定义默认资源阅读顺序。`linear=no` 是辅助用途标记，不应据此丢弃插图；spine 不是章定义。
- [EPUB 导航定义](https://www.w3.org/TR/epub-33/#sec-nav-def)及[TOC](https://www.w3.org/TR/epub-33/#sec-nav-toc)提供导航层级、标签和入口，支持资源内 fragment 和无链接分组标题。不能把每个父子目录项都重复渲染为正文。
- [EPUB flow](https://www.w3.org/TR/epub-33/#flow)包含动态分页、跨资源连续滚动与单资源滚动，没有强制阅读器必须分页。
- [EPUB 2 OPF／NCX](https://idpf.org/epub/20/spec/OPF_2.0.1_draft.htm#Section2.4.1)通过 `spine@toc` 引用目录，`navMap/navPoint` 提供层级、`navLabel/text` 提供名称、`content@src` 提供位置。

“按有效目录入口与连续资源组章”及“正文锚点恢复、百分比辅助”是本项目的工程选择，不是 EPUB 对所有阅读器强制规定的实现。内部 Unicode 码点坐标也不称为 CFI；[CFI 的字符偏移](https://idpf.org/epub/linking/cfi/epub-cfi.html#sec-path-terminating-char)采用 UTF-16 单元。
