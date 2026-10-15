import assert from "node:assert/strict";
import test from "node:test";
import {
	closeReaderPanel,
	EMPTY_READER_PANELS,
	fitImageSize,
	normalizeReaderQuery,
	readerQueryTooLong,
	selectReaderPanel,
} from "./reader-panel-logic.ts";

test("left navigation and right tools coexist and close independently", () => {
	const searching = selectReaderPanel(EMPTY_READER_PANELS, "search");
	const both = selectReaderPanel(searching, "settings", true);
	assert.deepEqual(both, {
		left: "search",
		right: "settings",
		activeSide: "right",
	});
	const changedRight = selectReaderPanel(both, "gallery", true);
	assert.deepEqual(changedRight, {
		left: "search",
		right: "gallery",
		activeSide: "right",
	});
	assert.deepEqual(closeReaderPanel(changedRight, "right"), {
		left: "search",
		right: null,
		activeSide: "left",
	});
	assert.deepEqual(selectReaderPanel(both, "toc", true), {
		left: null,
		right: "settings",
		activeSide: "right",
	});
	assert.deepEqual(closeReaderPanel(both, "left"), {
		left: null,
		right: "settings",
		activeSide: "right",
	});
	assert.deepEqual(closeReaderPanel(searching, "left"), EMPTY_READER_PANELS);
});

test("compact tools reveal a covered panel without clearing its selected tab", () => {
	const both = {
		left: "search",
		right: "settings",
		activeSide: "right",
	} as const;
	const revealed = selectReaderPanel(both, "toc", true, true);
	assert.deepEqual(revealed, { ...both, activeSide: "left" });
	assert.deepEqual(selectReaderPanel(revealed, "toc", true, true), {
		left: null,
		right: "settings",
		activeSide: "right",
	});
	assert.deepEqual(selectReaderPanel(revealed, "gallery", true, true), {
		left: "search",
		right: "gallery",
		activeSide: "right",
	});
});

test("reader query uses NFC, counts Unicode code points and preserves literal fullwidth text", () => {
	assert.equal(normalizeReaderQuery(" か\u3099Ａ.* "), "がＡ.*");
	assert.equal(readerQueryTooLong("𠮷".repeat(160)), false);
	assert.equal(readerQueryTooLong("𠮷".repeat(161)), true);
});
test("image fit preserves ratio, does not enlarge small originals and zoom is relative to fit", () => {
	assert.deepEqual(fitImageSize(1200, 600, 600, 400, 1), {
		width: 600,
		height: 300,
	});
	assert.deepEqual(fitImageSize(1200, 600, 600, 400, 2), {
		width: 1200,
		height: 600,
	});
	assert.deepEqual(fitImageSize(100, 200, 600, 400, 1), {
		width: 100,
		height: 200,
	});
});
