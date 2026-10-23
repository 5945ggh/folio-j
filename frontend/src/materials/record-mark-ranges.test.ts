import assert from "node:assert/strict";
import test from "node:test";
import { subtractMarkIntervals } from "./record-mark-ranges.ts";

test("translation intervals subtract the union of study coverage without changing inputs", () => {
	const source = [
		{ start: 0, end: 12 },
		{ start: 8, end: 16 },
	];
	const covered = [
		{ start: 10, end: 14 },
		{ start: 2, end: 5 },
		{ start: 4, end: 8 },
	];
	const before = structuredClone({ source, covered });
	assert.deepEqual(subtractMarkIntervals(source, covered), [
		{ start: 0, end: 2 },
		{ start: 8, end: 10 },
		{ start: 14, end: 16 },
	]);
	assert.deepEqual({ source, covered }, before);
});

test("half-open adjacent, wholly covered and duplicate translation intervals", () => {
	assert.deepEqual(
		subtractMarkIntervals(
			[{ start: 2, end: 5 }],
			[
				{ start: 0, end: 2 },
				{ start: 5, end: 7 },
			],
		),
		[{ start: 2, end: 5 }],
	);
	assert.deepEqual(
		subtractMarkIntervals([{ start: 2, end: 5 }], [{ start: 0, end: 7 }]),
		[],
	);
	assert.deepEqual(
		subtractMarkIntervals(
			[
				{ start: 2, end: 5 },
				{ start: 2, end: 5 },
				{ start: 5, end: 7 },
			],
			[],
		),
		[{ start: 2, end: 7 }],
	);
	assert.deepEqual(subtractMarkIntervals([], [{ start: 0, end: 7 }]), []);
});
