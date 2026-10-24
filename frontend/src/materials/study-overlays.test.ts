import assert from "node:assert/strict";
import test from "node:test";
import {
	nativeSelectionKey,
	studyOverlayPosition,
	studyPreviewPosition,
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

test("preview adapts its height to the space above or below without covering the target", () => {
	for (const anchor of [
		{ left: 200, right: 220, top: 240, bottom: 266 },
		{ left: 20, right: 370, top: 600, bottom: 626 },
		{ left: 200, right: 220, top: 350, bottom: 376 },
	]) {
		const position = studyPreviewPosition(
			anchor,
			{ width: 390, height: 800 },
			{ width: 366, height: 420 },
		);
		const height = Math.min(420, position.maxHeight);
		assert.ok(
			position.top + height <= anchor.top - 8 ||
				position.top >= anchor.bottom + 8,
		);
		assert.ok(position.top >= 64 && position.top + height <= 724);
		assert.ok(position.left >= 12 && position.left + 366 <= 378);
	}
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
