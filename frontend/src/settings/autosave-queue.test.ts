import assert from "node:assert/strict";
import { test } from "node:test";
import { createAutosaveQueue } from "./autosave-queue.ts";

test("rapid edits finish in order and coalesce to the last selection", async () => {
	const writes: number[] = [];
	let resolveFirst!: () => void;
	const first = new Promise<void>((resolve) => {
		resolveFirst = resolve;
	});
	const save = createAutosaveQueue(async ({ value }: { value: number }) => {
		writes.push(value);
		if (writes.length === 1) await first;
	});
	const pending = save({ value: 1 });
	await Promise.resolve();
	save({ value: 2 });
	const last = save({ value: 0 });
	assert.deepEqual(writes, [1]);
	resolveFirst();
	await Promise.all([pending, last]);
	assert.deepEqual(writes, [1, 0]);
});

test("a failed write stops queued overwrites until the caller retries", async () => {
	const writes: number[] = [];
	let rejectFirst!: (error: Error) => void;
	const first = new Promise<void>((_, reject) => {
		rejectFirst = reject;
	});
	const save = createAutosaveQueue(async ({ value }: { value: number }) => {
		writes.push(value);
		if (writes.length === 1) await first;
	});
	const pending = save({ value: 1 });
	await Promise.resolve();
	save({ value: 2 });
	rejectFirst(new Error("conflict"));
	await assert.rejects(pending, /conflict/);
	assert.deepEqual(writes, [1]);
	await save({ value: 3 });
	assert.deepEqual(writes, [1, 3]);
});
