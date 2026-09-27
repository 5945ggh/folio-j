import assert from "node:assert/strict";
import { test } from "node:test";
import { clampConversationWidth, conversationWidthRange } from "./layout.ts";

test("conversation width keeps room for reading on desktop", () => {
	assert.deepEqual(conversationWidthRange(1000), { min: 360, max: 620 });
	assert.deepEqual(conversationWidthRange(1600), { min: 360, max: 900 });
	assert.equal(clampConversationWidth(800, 1000), 620);
	assert.equal(clampConversationWidth(200, 1000), 360);
	assert.equal(clampConversationWidth(500, 1000), 500);
});
