import assert from "node:assert/strict";
import { test } from "node:test";
import { generationResult } from "./state.ts";

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
