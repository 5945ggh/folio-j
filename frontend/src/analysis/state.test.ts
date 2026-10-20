import assert from "node:assert/strict";
import { test } from "node:test";
import { generationResult } from "../chat/discussion.ts";
import { readingAnalysis } from "./state.ts";

test("主对话失败但已经保存成果时，不把讲解误报为未保存", () => {
	assert.equal(
		generationResult({
			status: "failed",
			artifacts: [{ analysis_id: "a", revision_id: "r" }],
		}),
		"saved_with_unfinished_reply",
	);
	assert.equal(
		generationResult({
			status: "interrupted",
			artifacts: [{ analysis_id: "a", revision_id: "r" }],
		}),
		"saved_with_unfinished_reply",
	);
});

test("失败且没有成果引用时显示未保存", () => {
	assert.equal(
		generationResult({ status: "failed", artifacts: [] }),
		"not_saved",
	);
	assert.equal(generationResult({ status: "running", artifacts: [] }), "none");
});

test("列表模式不打开缓存讲解，直达对象必须符合片段与文档归属", () => {
	const document = { id: "a", segment_id: "s", revision_id: "historical" };
	assert.equal(readingAnalysis(document, "s", null), null);
	assert.equal(readingAnalysis(document, "other", "a"), null);
	assert.equal(readingAnalysis(document, "s", "other"), null);
	assert.equal(readingAnalysis(undefined, "s", "a"), null);
	assert.equal(readingAnalysis(document, "s", "a"), document);
	assert.equal(readingAnalysis(document, "s", "a")?.revision_id, "historical");
});

test("详情重新请求失败时，不显示仍留在缓存中的正文", () => {
	const document = { id: "a", segment_id: "s" };
	assert.equal(readingAnalysis(document, "s", "a", true), null);
	assert.equal(readingAnalysis(document, "s", "a", false), document);
});
