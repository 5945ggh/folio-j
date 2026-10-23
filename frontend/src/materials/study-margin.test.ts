import assert from "node:assert/strict";
import test from "node:test";
import { studyMarginEntries } from "./study-margin.ts";

const viewport = { left: 100, right: 700, top: 80, bottom: 600 };
const content = { left: -5000, right: 5000, top: -5000, bottom: 5000 };
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
		content,
	);
	assert.deepEqual(
		entries.map((x) => x.segmentIds),
		[["0", "1"], ["2"]],
	);
	assert.ok(entries.every((x) => x.left >= viewport.right));
});
test("insufficient cross-axis whitespace hides buttons without squeezing the text", () => {
	assert.deepEqual(
		studyMarginEntries(
			marks,
			{ ...viewport, left: 32, right: 768 },
			{ width: 800, height: 800 },
			false,
			content,
		),
		[],
	);
});
test("vertical entries use measured bottom whitespace and stay outside the text", () => {
	const entries = studyMarginEntries(
		marks,
		viewport,
		{ width: 1000, height: 800 },
		true,
		content,
	);
	assert.equal(entries.length, 1);
	assert.equal(entries[0]?.top, 608);
	assert.equal(entries[0]?.segmentIds.length, 3);
	assert.deepEqual(
		studyMarginEntries(
			marks,
			viewport,
			{ width: 1000, height: 630 },
			true,
			content,
		),
		[],
	);
});

for (const vertical of [false, true]) {
	test(`${vertical ? "vertical" : "horizontal"} bookmarks keep the first original rect even when it is offscreen`, () => {
		const first = vertical
			? { left: 850, right: 870, top: 100, bottom: 150 }
			: rect(-100);
		const entries = studyMarginEntries(
			[{ id: "long", rects: [first, rect(100)] }],
			viewport,
			{ width: 1000, height: 800 },
			vertical,
			content,
		);
		assert.equal(entries.length, 1);
		assert.equal(
			vertical ? entries[0]?.left : entries[0]?.top,
			vertical ? first.left : first.top,
		);
	});
}

test("scrolling does not clamp or merge neighboring original anchors at the viewport edge", () => {
	const result = studyMarginEntries(
		[
			{ id: "a", rects: [rect(62)] },
			{ id: "b", rects: [rect(128)] },
		],
		viewport,
		{ width: 1000, height: 800 },
		false,
		content,
	);
	assert.deepEqual(
		result.map((entry) => [entry.top, entry.segmentIds]),
		[
			[62, ["a"]],
			[128, ["b"]],
		],
	);
});

test("the final bookmark hit box stays inside the existing chapter scroll extent", () => {
	const entries = studyMarginEntries(
		[{ id: "last", rects: [rect(3487)] }],
		viewport,
		{ width: 1000, height: 800 },
		false,
		{ left: 100, right: 700, top: 0, bottom: 3520 },
	);
	assert.equal(entries[0]?.top, 3476);
	assert.equal(entries[0]?.anchor.top, 3487);
});
