import assert from "node:assert/strict";
import { test } from "node:test";
import { analysisPresentation } from "./presentation.ts";

function present(source_md: string, title = "講解") {
	return analysisPresentation({ title, source_md, sections: [] });
}

test("首个简单 H1 承担标题，展示副本保留正文与源文", () => {
	const source = "\n# 原文の解説\n\n本文\n";
	const result = present(source);
	assert.equal(result.title?.markdown, "# 原文の解説\n");
	assert.equal(result.blocks[0]?.raw, "\n本文\n");
	assert.equal(source, "\n# 原文の解説\n\n本文\n");
});

test("相同 H2 使用 NFC 比较，允许合法缩进与结尾井号", () => {
	const result = present("  ## ガイド ###\r\n本文", "ガイド");
	assert.equal(result.title?.markdown, "  ## ガイド ###\r\n");
	assert.equal(result.blocks[0]?.raw, "本文");
	assert.equal(present("## 別の節\n本文").title, null);
});

test("代码围栏、缩进代码、正文后标题与非法井号不参与去重", () => {
	for (const markdown of [
		"```md\n# 講解\n```",
		"~~~\n## 講解\n~~~",
		"    # 講解\n本文",
		"本文\n# 講解",
		"#講解\n本文",
		"### 講解\n本文",
		"# ###\n本文",
		"\t# 講解\n本文",
	]) {
		const result = present(markdown);
		assert.equal(result.title, null, markdown);
		assert.equal(result.blocks[0]?.raw, markdown);
	}
	assert.equal(
		present("# 井号 # の説明 ###\n本文").title?.markdown,
		"# 井号 # の説明 ###\n",
	);
});

test("格式化、链接、实体、转义及 HTML 标题保守保留", () => {
	for (const heading of [
		"# **講解**",
		"## [講解](https://example.test)",
		"# `講解`",
		"# 講解 &amp; 引用",
		"# 講解\\*",
		"# <em>講解</em>",
	]) {
		assert.equal(present(`${heading}\n本文`).title, null, heading);
	}
});

test("空前言保留定位身份，标题由首个有内容讲解块承担", () => {
	const sections = [
		{ id: "preamble", kind: "preamble", raw: "\n \n" },
		{ id: "first", kind: "section", raw: "## 講解\n\n本文" },
		{ id: "next", kind: "section", raw: "## 次の節\n内容" },
	];
	const snapshot = structuredClone(sections);
	const result = analysisPresentation({
		title: "講解",
		source_md: sections.map((section) => section.raw).join(""),
		sections,
	});
	assert.equal(result.title?.sectionId, "first");
	assert.equal(result.blocks[0]?.id, "preamble");
	assert.equal(result.blocks[0]?.raw.trim(), "");
	assert.equal(result.blocks[1]?.id, "first");
	assert.equal(result.blocks[1]?.raw, "\n本文");
	assert.deepEqual(sections, snapshot);
});

test("旧版内容只按传入修订展示，不从其他版本恢复标题或正文", () => {
	const historical = {
		title: "旧版标题",
		source_md: "## 旧版标题\n旧版内容",
		sections: [{ id: "old-anchor", raw: "## 旧版标题\n旧版内容" }],
	};
	const result = analysisPresentation(historical);
	assert.equal(result.title?.sectionId, "old-anchor");
	assert.equal(result.blocks[0]?.raw, "旧版内容");
	assert.equal(present("\n\n").title, null);
});
