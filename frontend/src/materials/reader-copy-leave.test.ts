import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createReaderCopyLeaveAttempt,
	shouldBlockReaderCopyLeave,
} from "./reader-copy-leave.ts";

function deferred() {
	let resolve!: (value: boolean) => void;
	const promise = new Promise<boolean>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

test("only leaving the same material Reader protects a copy draft or an in-flight save", () => {
	for (const same of [
		"/materials/book",
		"/materials/book/",
		"/MATERIALS/book",
	]) {
		assert.equal(shouldBlockReaderCopyLeave("book", same, true), false);
	}
	assert.equal(
		shouldBlockReaderCopyLeave("book one", "/materials/book%20one/", true),
		false,
	);
	for (const other of [
		"/",
		"/segments/segment",
		"/materials/other",
		"/materials/book/details",
		"/settings",
	]) {
		assert.equal(shouldBlockReaderCopyLeave("book", other, true), true);
		assert.equal(shouldBlockReaderCopyLeave("book", other, false), false);
	}
});

test("repeated leave intents await one save result and proceed only on success", async () => {
	const attempt = createReaderCopyLeaveAttempt();
	const saved = deferred();
	let calls = 0;
	const outcomes: boolean[] = [];
	const save = () => {
		calls++;
		return saved.promise;
	};
	const first = attempt.wait(save, (result) => outcomes.push(result));
	const second = attempt.wait(save, () => assert.fail("duplicate navigation"));
	assert.equal(first, second);
	await Promise.resolve();
	assert.equal(calls, 1);
	assert.deepEqual(outcomes, []);
	saved.resolve(true);
	await first;
	assert.deepEqual(outcomes, [true]);
});

test("continue editing invalidates the pending navigation without cancelling its write", async () => {
	const attempt = createReaderCopyLeaveAttempt();
	const saved = deferred();
	let writes = 0;
	const save = () => {
		writes++;
		return saved.promise;
	};
	const previous = attempt.wait(save, () => assert.fail("cancelled leave"));
	await Promise.resolve();
	attempt.cancel();
	saved.resolve(true);
	await previous;
	assert.equal(writes, 1);
});

test("a second destination after cancellation can await the same background write", async () => {
	const attempt = createReaderCopyLeaveAttempt();
	const saved = deferred();
	const outcomes: string[] = [];
	const first = attempt.wait(
		() => saved.promise,
		() => outcomes.push("old destination"),
	);
	attempt.cancel();
	const second = attempt.wait(
		() => saved.promise,
		() => outcomes.push("new destination"),
	);
	saved.resolve(true);
	await Promise.all([first, second]);
	assert.deepEqual(outcomes, ["new destination"]);
});

test("a rejected save reports failure and leaves the navigation available for retry", async () => {
	const attempt = createReaderCopyLeaveAttempt();
	const outcomes: boolean[] = [];
	await attempt.wait(
		async () => {
			throw new Error("offline");
		},
		(result) => outcomes.push(result),
	);
	await attempt.wait(
		async () => true,
		(result) => outcomes.push(result),
	);
	assert.deepEqual(outcomes, [false, true]);
});
