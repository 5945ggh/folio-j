import assert from "node:assert/strict";
import { test } from "node:test";
import type { Location } from "react-router";
import {
	createReaderLeaveCoordinator,
	type ReaderLeaveKind,
} from "./reader-leave-coordinator.ts";

function destination(key = "library", pathname = "/"): Location {
	return { key, pathname, search: "", hash: "", state: null };
}

function participant(kind: ReaderLeaveKind, protectedDraft = true) {
	return {
		kind,
		shouldBlock: () => protectedDraft,
		beforeUnload: () => protectedDraft,
	};
}

test("two protected drafts resolve in segment then copy order regardless of mount order", () => {
	const coordinator = createReaderLeaveCoordinator();
	coordinator.register("copy", participant("copy"));
	coordinator.register("segment", participant("segment"));
	assert.equal(coordinator.shouldBlock(destination()), true);
	coordinator.begin(destination());
	const attempt = coordinator.getSnapshot().attempt;
	assert.equal(coordinator.getSnapshot().participantId, "segment");
	coordinator.proceed("segment", attempt);
	assert.equal(coordinator.getSnapshot().participantId, "copy");
	assert.equal(coordinator.getSnapshot().action, null);
	coordinator.proceed("segment", attempt);
	assert.equal(coordinator.getSnapshot().participantId, "copy");
	coordinator.proceed("copy", attempt);
	assert.equal(coordinator.getSnapshot().action, "proceed");
});

test("continue editing cancels the entire navigation and a later request asks both drafts again", () => {
	const coordinator = createReaderLeaveCoordinator();
	coordinator.register("segment", participant("segment"));
	coordinator.register("copy", participant("copy"));
	coordinator.begin(destination());
	const attempt = coordinator.getSnapshot().attempt;
	coordinator.proceed("segment", attempt);
	coordinator.reset("copy", attempt);
	assert.equal(coordinator.getSnapshot().action, "reset");
	coordinator.proceed("copy", attempt);
	assert.equal(coordinator.getSnapshot().action, "reset");
	coordinator.end();
	coordinator.begin(destination());
	assert.equal(coordinator.getSnapshot().participantId, "segment");
	assert.ok(coordinator.getSnapshot().attempt > attempt);
});

test("unmounting an unresolved participant cancels instead of bypassing another draft", () => {
	for (const removeCurrent of [true, false]) {
		const coordinator = createReaderLeaveCoordinator();
		const removeSegment = coordinator.register(
			"segment",
			participant("segment"),
		);
		const removeCopy = coordinator.register("copy", participant("copy"));
		coordinator.begin(destination());
		if (removeCurrent) removeSegment();
		else removeCopy();
		assert.equal(coordinator.getSnapshot().action, "reset");
		assert.equal(coordinator.getSnapshot().participantId, null);
	}
});

test("discarding and unmounting the resolved segment leaves the copy question active", () => {
	const coordinator = createReaderLeaveCoordinator();
	const removeSegment = coordinator.register("segment", participant("segment"));
	coordinator.register("copy", participant("copy"));
	coordinator.begin(destination());
	coordinator.proceed("segment", coordinator.getSnapshot().attempt);
	removeSegment();
	assert.equal(coordinator.getSnapshot().participantId, "copy");
	assert.equal(coordinator.getSnapshot().action, null);
});

test("late asynchronous consent cannot release a cancelled or replaced navigation", async () => {
	const coordinator = createReaderLeaveCoordinator();
	coordinator.register("copy", participant("copy"));
	coordinator.begin(destination());
	const oldAttempt = coordinator.getSnapshot().attempt;
	let finish!: () => void;
	const saved = new Promise<void>((resolve) => {
		finish = resolve;
	}).then(() => coordinator.proceed("copy", oldAttempt));
	coordinator.reset("copy", oldAttempt);
	coordinator.end();
	coordinator.begin(destination("different-book", "/materials/other"));
	finish();
	await saved;
	assert.equal(coordinator.getSnapshot().participantId, "copy");
	assert.equal(coordinator.getSnapshot().action, null);
	coordinator.proceed("copy", coordinator.getSnapshot().attempt);
	assert.equal(coordinator.getSnapshot().action, "proceed");
});

test("router pause clears navigation intent while retaining participant registration", () => {
	const coordinator = createReaderLeaveCoordinator();
	coordinator.register("copy", participant("copy"));
	coordinator.begin(destination());
	const oldAttempt = coordinator.getSnapshot().attempt;
	coordinator.end();
	coordinator.proceed("copy", oldAttempt);
	assert.equal(coordinator.getSnapshot().location, null);
	assert.equal(coordinator.getSnapshot().action, null);
	assert.equal(coordinator.shouldBlock(destination()), true);
	assert.equal(coordinator.beforeUnload(), true);
});

test("current server status is consulted before advancing to the next draft", () => {
	const coordinator = createReaderLeaveCoordinator();
	let dirty = true;
	coordinator.register("segment", participant("segment"));
	coordinator.register("copy", {
		kind: "copy",
		shouldBlock: () => dirty,
		beforeUnload: () => dirty,
	});
	coordinator.begin(destination());
	dirty = false;
	coordinator.proceed("segment", coordinator.getSnapshot().attempt);
	assert.equal(coordinator.getSnapshot().action, "proceed");
});

test("route-specific protection permits chapter changes while native leave checks every draft", () => {
	const coordinator = createReaderLeaveCoordinator();
	coordinator.register("copy", {
		kind: "copy",
		shouldBlock: (next) => next.pathname !== "/materials/book",
		beforeUnload: () => true,
	});
	assert.equal(
		coordinator.shouldBlock(destination("chapter", "/materials/book")),
		false,
	);
	assert.equal(coordinator.beforeUnload(), true);
	assert.equal(coordinator.shouldBlock(destination()), true);
});

test("repeated router snapshots never recreate the participant queue", () => {
	const coordinator = createReaderLeaveCoordinator();
	coordinator.register("segment", participant("segment"));
	coordinator.register("copy", participant("copy"));
	const target = destination();
	coordinator.begin(target);
	const attempt = coordinator.getSnapshot().attempt;
	coordinator.proceed("segment", attempt);
	coordinator.begin(target);
	assert.equal(coordinator.getSnapshot().participantId, "copy");
	assert.equal(coordinator.getSnapshot().attempt, attempt);
});

test("a newly mounted protected draft cannot be skipped before router completion", () => {
	const coordinator = createReaderLeaveCoordinator();
	coordinator.register("segment", participant("segment"));
	coordinator.begin(destination());
	coordinator.proceed("segment", coordinator.getSnapshot().attempt);
	assert.equal(coordinator.getSnapshot().action, "proceed");
	coordinator.register("copy", participant("copy"));
	assert.equal(coordinator.getSnapshot().participantId, "copy");
	assert.equal(coordinator.getSnapshot().action, null);
});
