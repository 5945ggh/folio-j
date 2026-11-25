import assert from "node:assert/strict";
import test from "node:test";
import { summarizeEpubImportWarnings } from "./epub-import-warnings.ts";

const summaries = [
	"部分图片无法显示，已跳过",
	"固定版式的图片页已按普通图片显示",
	"部分样式无法使用，页面外观可能与原书不同",
	"已根据可用的目录和正文调整章节划分",
];

test("summarizes Chinese warnings from newly imported EPUBs", () => {
	assert.deepEqual(
		summarizeEpubImportWarnings([
			"图片无法读取或格式不受支持，已跳过：OEBPS/chapter.xhtml",
			"固定版式的图片页已按普通图片显示：OEBPS/cover.xhtml",
			"样式引用的写法不受支持，已跳过：OEBPS/styles/main.css（nonsense）",
			"样式引用的适用条件不受支持，已跳过：OEBPS/styles/main.css（%）",
			"样式引用已跳过：OEBPS/styles/main.css 中的 base.css（文件缺失或无法读取）",
			"样式引用未正确结束，已移除：OEBPS/styles/main.css",
			"样式表无法读取，已跳过：OEBPS/chapter.xhtml（styles/missing.css）",
			"备用目录无法读取：toc.ncx",
			"目录不可用，已按原书的正文顺序划分章节",
		]),
		summaries,
	);
});

test("summarizes existing English and mixed-language stored warnings", () => {
	assert.deepEqual(
		summarizeEpubImportWarnings([
			"Removed unsupported image in OEBPS/chapter.xhtml",
			"Fixed image page rendered without fixed-layout geometry: OEBPS/cover.xhtml",
			"Unsupported CSS import syntax in OEBPS/styles/main.css: nonsense",
			"Unsupported CSS import condition in OEBPS/styles/main.css: %",
			"Skipped CSS import in OEBPS/styles/main.css: base.css",
			"Unterminated CSS import removed in OEBPS/styles/main.css",
			"Skipped unavailable stylesheet in OEBPS/chapter.xhtml",
			"EPUB nav 目录无法读取，尝试 NCX。",
			"EPUB NCX 目录无法读取。",
			"nav 目录没有有效正文目标，尝试 NCX。",
			"spine 重复资源保留全部出现位置；目录目标定位到首次出现。",
			"目录目标重复或逆序，已跳过：第二章",
			"没有有效目录，按原始 spine 资源组织阅读。",
		]),
		summaries,
	);
});

test("deduplicates summaries when legacy and current diagnostics share a cause", () => {
	assert.deepEqual(
		summarizeEpubImportWarnings([
			"Removed unsupported image in first.xhtml",
			"图片无法读取或格式不受支持，已跳过：second.xhtml",
			"Unknown diagnostic",
		]),
		["部分图片无法显示，已跳过", "部分 EPUB 内容已按兼容方式处理"],
	);
	assert.deepEqual(summarizeEpubImportWarnings([]), []);
});
