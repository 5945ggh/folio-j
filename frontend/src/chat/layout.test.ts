import assert from "node:assert/strict";
import { test } from "node:test";
import {
	clampConversationWidth,
	conversationWidthRange,
	MAX_CONVERSATION_WIDTH,
	MIN_CONVERSATION_WIDTH,
} from "./layout.ts";

test("width range caps wide workspaces, degrades narrowly, and expands while reserving reading room", () => {
	const narrow = MIN_CONVERSATION_WIDTH - 1;
	assert.deepEqual(conversationWidthRange(narrow), {
		min: MIN_CONVERSATION_WIDTH,
		max: MIN_CONVERSATION_WIDTH,
	});
	assert.equal(
		clampConversationWidth(MAX_CONVERSATION_WIDTH, narrow),
		MIN_CONVERSATION_WIDTH,
	);
	const desktop = conversationWidthRange(1000);
	const expanded = conversationWidthRange(1100);
	assert.equal(desktop.min, MIN_CONVERSATION_WIDTH);
	assert.equal(1000 - desktop.max, 380);
	assert.equal(expanded.max - desktop.max, 100);
	assert.ok(expanded.max > expanded.min);
	assert.ok(expanded.max < MAX_CONVERSATION_WIDTH);
	assert.equal(clampConversationWidth(desktop.min - 1, 1000), desktop.min);
	assert.equal(clampConversationWidth(desktop.max + 1, 1000), desktop.max);
	const inside = (desktop.min + desktop.max) / 2;
	assert.equal(clampConversationWidth(inside, 1000), inside);
	assert.equal(
		conversationWidthRange(MAX_CONVERSATION_WIDTH * 2).max,
		MAX_CONVERSATION_WIDTH,
	);
});
