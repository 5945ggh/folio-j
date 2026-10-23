import assert from "node:assert/strict";
import test from "node:test";
import { bookListState, cardWidth, sourceListState } from "./presentation.ts";

test("source lists distinguish confirmed empty content, search results and unresolved queries", () => {
	assert.equal(sourceListState(undefined, 0, ""), "loading");
	assert.equal(sourceListState(undefined, 0, "日文"), "loading");
	assert.equal(sourceListState(0, 0, ""), "empty");
	assert.equal(sourceListState(0, 0, "日文"), "no-results");
	assert.equal(sourceListState(2, 2, ""), "items");
	assert.equal(sourceListState(1, 1, "日文"), "items");
	assert.equal(sourceListState(51, 0, ""), "out-of-page");
});

test("empty library requires confirmed zero total and no active filters", () => {
	assert.equal(bookListState(0, 0, false, 1), "empty");
	assert.equal(bookListState(0, 0, true, 1), "no-results");
	assert.equal(bookListState(51, 0, false, 3), "out-of-page");
	assert.equal(bookListState(2, 2, false, 1), "books");
});
test("optional card preference remains inside the selected range", () => {
	for (const value of ["", "NaN", "139", "281"])
		assert.equal(cardWidth(value), 216);
	assert.equal(cardWidth("140"), 140);
	assert.equal(cardWidth("280"), 280);
});
