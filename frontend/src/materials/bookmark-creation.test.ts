import assert from "node:assert/strict";
import test from "node:test";
import { BookmarkCreationIntent } from "./bookmark-creation.ts";
import type { BookmarkCreate } from "./bookmarks-api.ts";

const first: BookmarkCreate = {
	request_id: "first-click",
	allow_nearby: false,
	position: {
		version_id: "v1",
		chapter_id: "c1",
		resource_id: "r1",
		part_index: 0,
		kind: "text",
		offset: 23,
		at_chapter_end: false,
	},
};
const second = {
	...first,
	request_id: "second-click",
	position: { ...first.position, offset: 99 },
};

test("unanswered and failed requests retain their identity and block a new capture", () => {
	const intent = new BookmarkCreationIntent();
	assert.equal(intent.start(first), true);
	assert.equal(intent.canRetry, true);
	assert.equal(intent.start(second), false);
	assert.equal(intent.request, first);
	intent.clear();
	assert.equal(intent.start(second), true);
});

test("nearby is a replaceable choice, and dismissing it clears the original intent", () => {
	const intent = new BookmarkCreationIntent();
	intent.start(first);
	intent.offerNearby();
	assert.equal(intent.canRetry, false);
	assert.equal(intent.start(second), true);
	assert.equal(intent.request, second);
	intent.offerNearby();
	intent.clear();
	assert.equal(intent.request, null);
	assert.equal(intent.nearby, false);
	assert.equal(intent.force(), null);
});

test("force uses the first frozen position and retry retains its opt-in flag", () => {
	const intent = new BookmarkCreationIntent();
	intent.start(first);
	intent.offerNearby();
	const forced = intent.force();
	assert.equal(forced?.request_id, first.request_id);
	assert.equal(forced?.position, first.position);
	assert.equal(forced?.allow_nearby, true);
	assert.equal(intent.canRetry, true);
	assert.equal(intent.isCurrent(first), false);
	assert.equal(forced && intent.isCurrent(forced), true);
	assert.equal(intent.start(second), false);
	assert.equal(intent.request, forced);
	assert.equal(intent.force(), null);
});

test("late results cannot complete a replacement intent or a dismissed nearby choice", () => {
	const intent = new BookmarkCreationIntent();
	intent.start(first);
	assert.equal(intent.isCurrent(first), true);
	intent.offerNearby();
	intent.start(second);
	assert.equal(intent.isCurrent(first), false);
	assert.equal(intent.isCurrent(second), true);
	intent.clear();
	assert.equal(intent.isCurrent(second), false);
});
