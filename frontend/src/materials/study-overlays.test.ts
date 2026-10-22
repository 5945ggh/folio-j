import assert from "node:assert/strict";
import test from "node:test";
import { nativeSelectionKey, studyOverlayPosition } from "./study-overlays.ts";

test("selection tools stay above the bottom controls and within narrow or vertical viewports", () => {
	assert.deepEqual(
		studyOverlayPosition(
			{ left: 20, right: 50, top: 100, bottom: 122 },
			{ width: 390, height: 844 },
			{ width: 220, height: 44 },
		),
		{ left: 12, top: 130 },
	);
	assert.deepEqual(
		studyOverlayPosition(
			{ left: 375, right: 395, top: 700, bottom: 735 },
			{ width: 390, height: 844 },
			{ width: 220, height: 44 },
		),
		{ left: 158, top: 648 },
	);
	assert.deepEqual(
		studyOverlayPosition(
			{ left: -20, right: 0, top: 70, bottom: 900 },
			{ width: 390, height: 844 },
			{ width: 300, height: 220 },
		),
		{ left: 12, top: 64 },
	);
});

test("native keyboard range extension wins over reading scroll shortcuts", () => {
	for (const key of [
		"ArrowLeft",
		"ArrowRight",
		"ArrowUp",
		"ArrowDown",
		"Home",
		"End",
		"PageUp",
		"PageDown",
	])
		assert.equal(nativeSelectionKey({ key, shiftKey: true }), true);
	assert.equal(
		nativeSelectionKey({ key: "ArrowDown", shiftKey: false }),
		false,
	);
	assert.equal(nativeSelectionKey({ key: " ", shiftKey: true }), false);
});
