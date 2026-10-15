import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_SOURCE_DIRECTORY_WIDTH,
	MAX_SOURCE_DIRECTORY_WIDTH,
	MIN_SOURCE_DIRECTORY_WIDTH,
	sourceDirectoryWidth,
} from "./directory-layout.ts";

test("returns persisted widths inside the allowed range", () => {
	assert.equal(sourceDirectoryWidth("220"), 220);
	assert.equal(sourceDirectoryWidth("260"), 260);
	assert.equal(sourceDirectoryWidth("360"), 360);
});

test("returns the default width for blank, non-numeric, or non-finite values", () => {
	for (const value of [
		"",
		"   ",
		"not-a-width",
		"NaN",
		"Infinity",
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])
		assert.equal(sourceDirectoryWidth(value), DEFAULT_SOURCE_DIRECTORY_WIDTH);
});

test("clamps persisted widths outside the allowed range", () => {
	assert.equal(sourceDirectoryWidth("219"), MIN_SOURCE_DIRECTORY_WIDTH);
	assert.equal(sourceDirectoryWidth("361"), MAX_SOURCE_DIRECTORY_WIDTH);
});

test("rounds finite drag widths after clamping them into the allowed range", () => {
	assert.equal(sourceDirectoryWidth(259.5), 260);
	assert.equal(sourceDirectoryWidth(220.4), 220);
	assert.equal(sourceDirectoryWidth(360.4), 360);
});
