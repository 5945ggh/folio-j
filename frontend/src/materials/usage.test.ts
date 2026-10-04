import assert from "node:assert/strict";
import test from "node:test";
import { freshestUsage, OpenAction } from "./usage.ts";

test("duplicate ready callbacks and repeated effects send one open action", async () => {
	const action = new OpenAction("mount");
	let calls = 0;
	let release = () => {};
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	const send = async () => {
		calls++;
		await wait;
	};
	const first = action.run(2, send);
	const second = action.run(2, send);
	release();
	await Promise.all([first, second]);
	await action.run(3, send);
	assert.equal(calls, 1);
});
test("uncertain retries keep the original action and expected revision", async () => {
	const action = new OpenAction("mount");
	await assert.rejects(
		action.run(2, async () => {
			throw new Error("offline");
		}),
	);
	await action.run(4, async (id, revision) => {
		assert.equal(id, "mount");
		assert.equal(revision, 2);
	});
});
test("late opened response cannot replace newer manual status", () => {
	const previous = { revision: 5, status: "completed" };
	assert.equal(
		freshestUsage(previous, { revision: 4, status: "in_progress" }),
		previous,
	);
});
