import assert from "node:assert/strict";
import test from "node:test";
import { completeChapterMarks } from "./study-marks.ts";

test("chapter hits wait for every page, including empty scans and overlaps beyond 100 records", () => {
	const first = {
		items: Array.from({ length: 100 }, (_, id) => ({ segment_id: String(id) })),
		next_cursor: "100",
	};
	const empty = { items: [], next_cursor: "200" };
	const last = { items: [{ segment_id: "100" }], next_cursor: null };
	assert.deepEqual(completeChapterMarks(undefined), []);
	assert.deepEqual(completeChapterMarks([first]), []);
	assert.deepEqual(completeChapterMarks([first, empty]), []);
	assert.equal(completeChapterMarks([first, empty, last]).length, 101);
	assert.equal(
		completeChapterMarks([first, empty, last]).at(-1)?.segment_id,
		"100",
	);
	assert.equal(completeChapterMarks([first, last, last]).length, 101);
});
