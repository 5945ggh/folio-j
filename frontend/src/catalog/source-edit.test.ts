import assert from "node:assert/strict";
import test from "node:test";
import { changedSourceFields } from "./source-edit.ts";

const initial = { title: "来源", description: "作品描述", note: "保留的备注" };

test("source editing sends only changed fields and preserves explicit clearing", () => {
	assert.deepEqual(
		changedSourceFields({ ...initial, title: "新名称" }, initial),
		{ title: "新名称" },
	);
	assert.deepEqual(changedSourceFields({ ...initial, note: "" }, initial), {
		note: "",
	});
	assert.deepEqual(changedSourceFields({ ...initial }, initial), {});
	assert.deepEqual(initial, {
		title: "来源",
		description: "作品描述",
		note: "保留的备注",
	});
});
