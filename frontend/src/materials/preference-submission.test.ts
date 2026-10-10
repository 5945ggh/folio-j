import assert from "node:assert/strict";
import test from "node:test";
import { ReaderPreferenceSubmission } from "./preference-submission.ts";
import { type BookUiPreferences, DEFAULT_BOOK_UI } from "./preferences.ts";

function required<T>(value: T | undefined): T {
	assert.ok(value);
	return value;
}
function deferred() {
	let resolve!: () => void;
	let reject!: (failure: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function fixture() {
	const submission = new ReaderPreferenceSubmission();
	const pending: ReturnType<typeof deferred>[] = [];
	const writes: BookUiPreferences[] = [];
	const commits: BookUiPreferences[] = [];
	let preparing = false;
	let error: Error | null = null;
	let storageFailed = false;
	let storageWorks = true;
	let layouts = 0;
	let current: BookUiPreferences = { ...DEFAULT_BOOK_UI };
	const bind = (chapter = "one", readingsReady = false) =>
		submission.bind({
			chapter,
			current,
			readingsReady,
			loadReadings: () => {
				const request = deferred();
				pending.push(request);
				return request.promise;
			},
			status: (busy, failure) => {
				preparing = busy;
				error = failure;
			},
			store: (next) => {
				writes.push(next);
				return storageWorks;
			},
			commit: (next, result) => {
				commits.push(next);
				current = next;
				layouts += Number(result.geometryChanged);
				storageFailed = result.storageFailed;
			},
		});
	bind();
	return {
		change: (next: BookUiPreferences) => submission.submit(next),
		bind,
		suspend: () => submission.suspend(),
		pending,
		writes,
		commits,
		failStorage: () => {
			storageWorks = false;
		},
		state: () => ({ preparing, error, storageFailed, layouts }),
	};
}
const all = { ...DEFAULT_BOOK_UI, rubyScope: "all" as const };

test("late success and failure preserve a newer pending preference and its status", async () => {
	for (const failure of [false, true]) {
		const f = fixture();
		const old = f.change(all);
		const current = f.change({ ...all, ruby: "hide" });
		if (failure) required(f.pending[0]).reject(new Error("old failure"));
		else required(f.pending[0]).resolve();
		await old;
		assert.equal(f.state().preparing, true);
		assert.equal(f.state().error, null);
		assert.equal(f.commits.length, 0);
		assert.equal(f.writes.length, 0);
		required(f.pending[1]).resolve();
		await current;
		assert.equal(required(f.commits[0]).ruby, "hide");
		assert.equal(f.writes.length, 1);
		assert.equal(f.state().preparing, false);
	}
});
test("chapter invalidation and unmount reject a pending successful submission", async () => {
	for (const stop of ["chapter", "unmount"] as const) {
		const f = fixture();
		const run = f.change(all);
		if (stop === "chapter") {
			f.bind("two");
		} else f.suspend();
		required(f.pending[0]).resolve();
		await run;
		assert.equal(f.commits.length, 0);
		assert.equal(f.writes.length, 0);
		assert.equal(f.state().layouts, 0);
	}
});
test("current asset failure reports the error without committing or storing", async () => {
	const f = fixture();
	const run = f.change(all);
	const failure = new Error("readings unavailable");
	required(f.pending[0]).reject(failure);
	await run;
	assert.equal(f.state().error, failure);
	assert.equal(f.state().preparing, false);
	assert.equal(f.commits.length, 0);
	assert.equal(f.writes.length, 0);
	assert.equal(f.state().layouts, 0);
});
test("appearance submission skips geometry while geometry submission surfaces storage failure", async () => {
	const f = fixture();
	await f.change({ ...DEFAULT_BOOK_UI, ruby: "hide" });
	assert.equal(f.state().layouts, 0);
	assert.equal(f.writes.length, 1);
	f.failStorage();
	await f.change({ ...DEFAULT_BOOK_UI, width: 900 });
	assert.equal(f.state().layouts, 1);
	assert.equal(f.state().storageFailed, true);
	assert.equal(f.commits.length, 2);
	assert.equal(f.writes.length, 2);
});

test("chapter reset isolates late failure and clears the old preparing status", async () => {
	const f = fixture();
	const old = f.change(all);
	f.bind("two");
	assert.equal(f.state().preparing, false);
	required(f.pending[0]).reject(new Error("old chapter failure"));
	await old;
	assert.equal(f.state().error, null);
	assert.equal(f.writes.length, 0);
});
test("suspend and reactivation cannot revive old success or failure", async () => {
	for (const failure of [false, true]) {
		const f = fixture();
		const old = f.change(all);
		f.suspend();
		await f.change(DEFAULT_BOOK_UI);
		assert.equal(f.commits.length, 0);
		f.bind();
		const current = f.change({ ...all, ruby: "hide" });
		if (failure) required(f.pending[0]).reject(new Error("previous lifetime"));
		else required(f.pending[0]).resolve();
		await old;
		assert.equal(f.state().preparing, true);
		assert.equal(f.state().error, null);
		assert.equal(f.writes.length, 0);
		required(f.pending[1]).resolve();
		await current;
		assert.equal(f.commits.length, 1);
	}
});
test("consecutive reset intents retain the last geometry and discard pending all-range assets", async () => {
	const f = fixture();
	const waiting = f.change(all);
	await f.change({ ...DEFAULT_BOOK_UI, width: 900 });
	await f.change(DEFAULT_BOOK_UI);
	required(f.pending[0]).resolve();
	await waiting;
	assert.deepEqual(f.commits, [
		{ ...DEFAULT_BOOK_UI, width: 900 },
		DEFAULT_BOOK_UI,
	]);
	assert.equal(f.state().layouts, 2);
	assert.equal(f.state().preparing, false);
	assert.equal(f.state().error, null);
	assert.equal(f.writes.length, 2);
});

test("same-chapter bind preserves a pending intent through readings cache updates", async () => {
	const f = fixture();
	const run = f.change(all);
	f.bind("one", true);
	assert.equal(f.state().preparing, true);
	required(f.pending[0]).resolve();
	await run;
	assert.deepEqual(f.commits, [all]);
	assert.equal(f.state().preparing, false);
});
