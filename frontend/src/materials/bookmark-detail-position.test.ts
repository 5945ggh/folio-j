import assert from "node:assert/strict";
import test from "node:test";
import { bookmarkDetailPosition } from "./bookmark-detail-position.ts";

test("wide detail stays adjacent to the panel and within the viewport", () => {
	const placement = bookmarkDetailPosition(
		{ right: 392, top: 76 },
		{ width: 1440, height: 900 },
	);
	assert.equal(placement.left, 404);
	assert.equal(placement.top, 76);
	assert.equal(placement.width, 420);
	assert.ok(placement.left + placement.width <= 1428);
	assert.equal(placement.top + placement.maxHeight, 888);
});

test("narrow detail remains within the viewport without depending on list scrolling", () => {
	for (const width of [320, 390, 600, 720]) {
		const placement = bookmarkDetailPosition(
			{ right: 392, top: 76 },
			{ width, height: 540 },
		);
		assert.ok(placement.left >= 12);
		assert.ok(placement.left + placement.width <= width - 12);
		assert.ok(placement.top + placement.maxHeight <= 528);
	}
});
