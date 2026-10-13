import assert from "node:assert/strict";
import test from "node:test";
import {
	anchorBeforeLayout,
	chapterProgress,
	currentSurface,
	imageAtReadingEdge,
	imageCoordinate,
	imageFraction,
	nearestLineBoundary,
	PositionQueue,
	rawBoundary,
	rawOffset,
	scrollProgress,
} from "./position.ts";

test("resource code points preserve non-BMP and reject NFC interior", () => {
	assert.equal(rawBoundary("𠮷が", 2), 1);
	assert.equal(rawOffset("𠮷が", 1), 2);
	assert.throws(() => rawBoundary("𠮷", 1));
	assert.throws(() => rawBoundary("か\u3099", 1));
	assert.equal(rawOffset("か\u3099", 1), 2);
});
test("image-only progress never divides by zero and clamps", () => {
	assert.equal(scrollProgress(10, 0), 0);
	assert.equal(scrollProgress(-10, 100), 0);
	assert.equal(scrollProgress(150, 100), 1);
});

test("leading-image whitespace follows horizontal and right-to-left reading edges", () => {
	assert.equal(imageAtReadingEdge(0, 20, 300, false, true), true);
	assert.equal(imageAtReadingEdge(0, 20, 300, false, false), false);
	assert.equal(imageAtReadingEdge(350, 20, 300, true, true), true);
	assert.equal(imageAtReadingEdge(350, 20, 300, true, false), false);
	assert.equal(imageAtReadingEdge(0, 20, 300, true, true), false);
	assert.equal(imageAtReadingEdge(350, 20, 300, false, true), false);
	assert.equal(imageAtReadingEdge(100, 20, 300, true, false), true);
	assert.equal(imageAtReadingEdge(0, 20, 0, false, true), false);
});
test("CAS queue serializes writes and coalesces newer positions", async () => {
	const calls: { value: number; revision: number }[] = [];
	let release: () => void = () => {};
	const blocker = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queue = new PositionQueue<number>(
		0,
		async (value, revision) => {
			calls.push({ value, revision });
			if (value === 1) await blocker;
			return revision + 1;
		},
		() => {},
	);
	queue.enqueue(1);
	queue.enqueue(2);
	queue.enqueue(3);
	release();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(calls, [
		{ value: 1, revision: 0 },
		{ value: 3, revision: 1 },
	]);
	assert.equal(queue.revision, 2);
});
test("conflict stops automatic retries and subsequent observations", async () => {
	let calls = 0;
	const states: string[] = [];
	const queue = new PositionQueue<number>(
		3,
		async () => {
			calls++;
			throw new Error("409");
		},
		(state) => states.push(state),
	);
	queue.enqueue(1);
	await new Promise((resolve) => setTimeout(resolve, 0));
	queue.enqueue(2);
	await queue.flush();
	assert.equal(calls, 1);
	assert.deepEqual(states, ["saving", "error"]);
});

test("long paragraphs locate visible line instead of paragraph start with bounded probes", () => {
	let probes = 0;
	const line = nearestLineBoundary(100000, 1800, (index) => {
		probes++;
		return Math.floor(index / 40) * 20;
	});
	assert.equal(line, 3600);
	assert.ok(probes < 40);
	const vertical = nearestLineBoundary(100000, -200, (index) => {
		return -2000 + Math.floor(index / 40) * 20;
	});
	assert.equal(vertical, 3600);
});
test("horizontal and right-origin vertical image locations round trip", () => {
	for (const vertical of [false, true])
		for (const progress of [0, 0.2, 0.8, 1]) {
			const coordinate = imageCoordinate(progress, 30, 800, vertical);
			assert.equal(imageFraction(coordinate, 30, 800, vertical), progress);
		}
});
test("stale frame load and detached surfaces cannot register or restore", () => {
	assert.equal(currentSurface(1, 2, true, true), false);
	assert.equal(currentSurface(2, 2, false, true), false);
	assert.equal(currentSurface(2, 2, true, false), false);
	assert.equal(currentSurface(2, 2, true, true), true);
});

test("consecutive setting changes preserve text anchor while only splash frame has loaded", () => {
	const text = { part_index: 1, kind: "text", offset: 895, font: 20 };
	const splash = { part_index: 0, kind: "image", offset: 0, font: 22 };
	let captures = 0;
	const capture = () => {
		captures++;
		return splash;
	};
	let pending = anchorBeforeLayout(false, null, () => text);
	const first = anchorBeforeLayout(true, pending, capture);
	assert.ok(first);
	pending = { ...first, font: 21 };
	const second = anchorBeforeLayout(true, pending, capture);
	assert.ok(second);
	pending = { ...second, font: 22 };
	assert.equal(captures, 0);
	assert.equal(pending.part_index, 1);
	assert.equal(pending.offset, 895);
	assert.equal(pending.font, 22);
});
test("long decomposed Japanese restores using only target grapheme boundary probes", () => {
	const raw = "か\u3099".repeat(20000);
	const original = String.prototype.normalize;
	let wholeProbes = 0;
	try {
		String.prototype.normalize = function (this: string, form?: string) {
			if (this.length >= raw.length / 2) wholeProbes++;
			return original.call(this, form);
		};
		assert.equal(rawOffset(raw, 15000), 30000);
		assert.ok(
			wholeProbes < 10,
			`unexpected full-prefix normalization probes: ${wholeProbes}`,
		);
	} finally {
		String.prototype.normalize = original;
	}
});

test("chapter queue preserves visits to distinct chapters and latest overall order", async () => {
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const calls: string[] = [];
	const queue = new PositionQueue<{ chapter: string; offset: number }>(
		0,
		async (value, revision) => {
			calls.push(`${value.chapter}:${value.offset}`);
			if (calls.length === 1) await gate;
			return revision + 1;
		},
		() => {},
		(value) => value.chapter,
	);
	queue.enqueue({ chapter: "A", offset: 1 });
	queue.enqueue({ chapter: "B", offset: 2 });
	queue.enqueue({ chapter: "A", offset: 3 });
	queue.enqueue({ chapter: "B", offset: 4 });
	release();
	await queue.flush();
	assert.deepEqual(calls, ["A:1", "A:3", "B:4"]);
	assert.equal(queue.revision, 3);
});
test("chapter progress uses part spans and canonical code points rather than scroll geometry", () => {
	const parts = [
		{ resource_id: "a", start: 2, end: 6 },
		{ resource_id: "b", start: 0, end: 6 },
	];
	const resources = [
		{ id: "a", text: "__𠮷日本語" },
		{ id: "b", text: "あいうえおか" },
	];
	assert.equal(
		chapterProgress(parts, resources, {
			part_index: 1,
			kind: "text",
			offset: 1,
		}),
		0.5,
	);
	assert.equal(
		chapterProgress(parts, resources, { part_index: 1, kind: "image" }),
		0.4,
	);
	assert.equal(
		chapterProgress(parts, resources, {
			part_index: 0,
			kind: "text",
			offset: 2,
		}),
		0,
	);
	assert.equal(
		chapterProgress(parts, resources, {
			part_index: 1,
			kind: "text",
			offset: 99,
		}),
		1,
	);
	assert.equal(
		chapterProgress(
			[{ resource_id: "a", start: 0, end: 2 }],
			[{ id: "a", text: " \n" }],
			{ part_index: 0, kind: "image" },
		),
		null,
	);
	assert.equal(
		chapterProgress(
			[{ resource_id: "a", start: 1, end: 2 }],
			[{ id: "a", text: "𠮷語" }],
			{ part_index: 0, kind: "text", offset: 2 },
		),
		1,
	);
});
