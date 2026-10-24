import assert from "node:assert/strict";
import test from "node:test";
import {
	advanceRetainedSession,
	emptyRetainedSession,
} from "./retained-session.ts";

test("retains one view and freezes its value until an explicit return", () => {
	const location = { path: "/book/a" };
	const first = advanceRetainedSession(
		emptyRetainedSession<typeof location>(),
		{ key: "a", value: location },
		false,
		0,
		100,
	);
	assert.equal(advanceRetainedSession(first, first.entry, false, 10), first);
	const paused = advanceRetainedSession(first, null, true, 20, 100);
	assert.equal(paused.entry?.value, location);
	assert.equal(paused.active, false);
	assert.equal(paused.expiresAt, 120);
	assert.equal(advanceRetainedSession(paused, null, true, 80, 100), paused);
	const returned = advanceRetainedSession(
		paused,
		{ key: "a", value: { path: "/book/a?segment=one" } },
		false,
		90,
		100,
	);
	assert.equal(returned.instance, first.instance);
	assert.equal(returned.activation, 1);
	assert.equal(returned.entry?.value.path, "/book/a?segment=one");
	assert.equal(returned.expiresAt, null);
});

test("expiry is checked on return even when the expiry timer has not run", () => {
	const first = advanceRetainedSession(
		emptyRetainedSession<string>(),
		{ key: "a", value: "a" },
		true,
		0,
		100,
	);
	const paused = advanceRetainedSession(first, null, true, 20, 100);
	const returned = advanceRetainedSession(paused, first.entry, true, 120, 100);
	assert.notEqual(returned.instance, first.instance);
	assert.equal(returned.activation, 0);
	assert.equal(advanceRetainedSession(paused, null, true, 120).entry, null);
});

test("a different view or leaving the eligible route evicts the old instance", () => {
	const first = advanceRetainedSession(
		emptyRetainedSession<string>(),
		{ key: "a", value: "a" },
		true,
		0,
	);
	const second = advanceRetainedSession(
		first,
		{ key: "b", value: "b" },
		true,
		1,
	);
	assert.equal(second.entry?.value, "b");
	assert.notEqual(second.instance, first.instance);
	const evicted = advanceRetainedSession(second, null, false, 2);
	assert.equal(evicted.entry, null);
	const reopened = advanceRetainedSession(evicted, second.entry, true, 3);
	assert.notEqual(reopened.instance, second.instance);
});

test("active query changes preserve the instance and a zero lease disables retention", () => {
	const first = advanceRetainedSession(
		emptyRetainedSession<string>(),
		{ key: "a", value: "a" },
		false,
		0,
	);
	const changed = advanceRetainedSession(
		first,
		{ key: "a", value: "a?segment=other" },
		false,
		1,
	);
	assert.equal(changed.instance, first.instance);
	assert.equal(changed.activation, first.activation);
	assert.equal(advanceRetainedSession(changed, null, true, 2, 0).entry, null);
});
