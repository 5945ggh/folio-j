import assert from "node:assert/strict";
import test from "node:test";
import {
	nativeSelectionKey,
	studyOverlayPosition,
	studySidebarPosition,
} from "./study-overlays.ts";

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

test("完整阅读侧栏使用全部可用高度，窄屏不受预览高度限制", () => {
	assert.deepEqual(studySidebarPosition({ width: 1280, height: 900 }, 460), {
		left: 808,
		top: 76,
		maxHeight: 748,
	});
	assert.deepEqual(studySidebarPosition({ width: 390, height: 844 }, 366), {
		left: 12,
		top: 76,
		maxHeight: 692,
	});
});

test("完整阅读侧栏为播放条留出空间，短视口仍保留顶部边距", () => {
	assert.deepEqual(
		studySidebarPosition({ width: 1280, height: 900 }, 460, 200),
		{ left: 808, top: 76, maxHeight: 624 },
	);
	assert.deepEqual(studySidebarPosition({ width: 844, height: 390 }, 460), {
		left: 372,
		top: 12,
		maxHeight: 302,
	});
});
