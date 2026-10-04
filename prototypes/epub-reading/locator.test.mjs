import test from "node:test";
import assert from "node:assert/strict";
import { rawBoundary, rawOffset, validateQuote } from "./locator.mjs";
test("whole-stream NFC boundaries reject composition interior", () => {
	assert.equal(rawBoundary("か\u3099😀", 2), 1);
	assert.equal(rawBoundary("か\u3099😀", 4), 2);
	assert.throws(() => rawBoundary("か\u3099😀", 1));
	assert.throws(() => rawBoundary("か\u3099😀", 3));
	assert.equal(rawOffset("か\u3099😀", 1), 2);
});
test("exact identity rejects mismatches without matching duplicate strings", () => {
	const b = { materialVersion: "v1" },
		r = { id: "r1", text: "同じ同じ" };
	const q = {
		materialVersion: "v1",
		resourceId: "r1",
		start: 2,
		end: 4,
		exact: "同じ",
	};
	validateQuote(q, b, r);
	for (const change of [
		{ materialVersion: "v2" },
		{ resourceId: "r2" },
		{ exact: "違う" },
		{ start: -1 },
		{ end: 5 },
	])
		assert.throws(() => validateQuote({ ...q, ...change }, b, r));
});
test("long NFC chapter restores tail in a single code-point walk", () => {
	const raw = "日本語😀".repeat(12000);
	const start = performance.now();
	assert.equal(rawOffset(raw, 47999), raw.length - 2);
	assert.equal(rawOffset(raw, 48000), raw.length);
	assert.ok(performance.now() - start < 1000, "tail lookup exceeded 1 second");
});
test("long decomposed chapter verifies local boundary using browser grapheme segmentation", () => {
	const raw = "日".repeat(44000) + "か\u3099😀";
	const start = performance.now();
	assert.equal(rawOffset(raw, 44001), 44002);
	assert.equal(rawOffset(raw, 44002), 44004);
	assert.ok(
		performance.now() - start < 1000,
		"decomposed tail lookup exceeded 1 second",
	);
});
