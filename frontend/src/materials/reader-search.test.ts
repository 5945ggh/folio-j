import assert from "node:assert/strict";
import test from "node:test";
import {
	searchTextParts,
	selectedSearchChapters,
	toggleSearchChapter,
} from "./reader-search.ts";

test("chapter combinations preserve book order and keep empty distinct from all", () => {
	const ids = ["a", "b", "c"];
	assert.deepEqual(selectedSearchChapters(null, ids), ids);
	assert.deepEqual(selectedSearchChapters([], ids), []);
	assert.deepEqual(toggleSearchChapter(null, ids, "b"), ["a", "c"]);
	assert.equal(toggleSearchChapter(["c", "a"], ids, "b"), null);
	assert.deepEqual(toggleSearchChapter(["a"], ids, "a"), []);
	assert.deepEqual(selectedSearchChapters(["gone", "c", "a"], ids), ["a", "c"]);
});
test("result highlights are literal and preserve Unicode and overlapping text", () => {
	for (const [text, query, expected] of [
		["𠮷.*が.*", ".*", ".*.*"],
		["あああ", "ああ", "あああ"],
		["a𠮷b", "𠮷", "𠮷"],
		["ＡA", "A", "A"],
		["abc", "", ""],
	]) {
		const parts = searchTextParts(text ?? "", query ?? "");
		assert.equal(parts.map((part) => part.text).join(""), text);
		assert.equal(
			parts
				.filter((part) => part.matched)
				.map((part) => part.text)
				.join(""),
			expected,
		);
	}
});
