import assert from "node:assert/strict";
import test from "node:test";
import { studyMarginEntries } from "./study-margin.ts";

const viewport = { left: 100, right: 700, top: 80, bottom: 600 };
const rect = (top: number) => ({
	left: 120,
	right: 190,
	top,
	bottom: top + 20,
});
const marks = [100, 120, 250].map((top, i) => ({
	id: String(i),
	rects: [rect(top)],
}));
test("real margins group collisions and retain every independent record", () => {
	const entries = studyMarginEntries(
		marks,
		viewport,
		{ width: 1000, height: 800 },
		false,
		[],
	);
	assert.deepEqual(
		entries.map((x) => x.segmentIds),
		[["0", "1"], ["2"]],
	);
	assert.ok(entries.every((x) => x.left >= viewport.right));
});
test("insufficient width, offscreen ranges and reserved controls produce no overlapping buttons", () => {
	assert.deepEqual(
		studyMarginEntries(
			marks,
			{ ...viewport, left: 32, right: 768 },
			{ width: 800, height: 800 },
			false,
			[],
		),
		[],
	);
	assert.deepEqual(
		studyMarginEntries(
			[{ id: "old", rects: [rect(700)] }],
			viewport,
			{ width: 1000, height: 800 },
			false,
			[],
		),
		[],
	);
	assert.deepEqual(
		studyMarginEntries(marks, viewport, { width: 1000, height: 800 }, false, [
			{ left: 700, right: 800, top: 80, bottom: 600 },
		]),
		[],
	);
});
test("vertical entries use measured bottom whitespace, keep content horizontal and avoid footer", () => {
	const entries = studyMarginEntries(
		marks,
		viewport,
		{ width: 1000, height: 800 },
		true,
		[],
	);
	assert.equal(entries.length, 1);
	assert.equal(entries[0]?.top, 608);
	assert.equal(entries[0]?.segmentIds.length, 3);
	assert.deepEqual(
		studyMarginEntries(marks, viewport, { width: 1000, height: 630 }, true, []),
		[],
	);
	assert.deepEqual(
		studyMarginEntries(marks, viewport, { width: 1000, height: 800 }, true, [
			{ left: 100, right: 700, top: 600, bottom: 700 },
		]),
		[],
	);
});
