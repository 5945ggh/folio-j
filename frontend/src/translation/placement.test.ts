import assert from "node:assert/strict";
import test from "node:test";
import { translationCardPosition } from "./placement.ts";

const size = { width: 360, height: 280 };
const viewport = { width: 1280, height: 800 };
test("页边浮卡优先向留白外侧展开，空间不足时向正文侧展开", () => {
	for (const [placement, left, expectedLeft] of [
		["margin-right", 850, 902],
		["margin-right", 1100, 732],
		["margin-left", 450, 82],
		["margin-left", 40, 92],
	] as const) {
		const anchor = { left, right: left + 44, top: 200, bottom: 244 };
		const placed = translationCardPosition(
			anchor,
			viewport,
			size,
			"horizontal-tb",
			76,
			placement,
		);
		assert.equal(placed.left, expectedLeft);
		assert.equal(placed.top, anchor.top);
	}
});
test("竖排底部页边入口在按钮上方打开，保持按钮可见", () => {
	const anchor = { left: 700, right: 744, top: 650, bottom: 694 };
	const placed = translationCardPosition(
		anchor,
		viewport,
		size,
		"vertical-rl",
		76,
		"margin-bottom",
	);
	assert.equal(placed.left + size.width / 2, (anchor.left + anchor.right) / 2);
	assert.equal(placed.top + size.height, anchor.top - 8);
});
test("底部页边按钮落在导航预留区时仍贴近按钮，不回退右上角", () => {
	for (const top of [828, 860]) {
		const anchor = { left: 940, right: 984, top, bottom: top + 44 };
		const placed = translationCardPosition(
			anchor,
			{ width: 1280, height: 900 },
			size,
			"vertical-rl",
			76,
			"margin-bottom",
		);
		assert.equal(placed.left + size.width / 2, 962);
		assert.equal(placed.top + size.height, Math.min(top - 8, 824));
	}
});
test("页边入口靠近视口边缘时卡片受限，窄屏统一停靠底部", () => {
	for (const width of [320, 640, 1280]) {
		for (const placement of [
			"margin-left",
			"margin-right",
			"margin-bottom",
		] as const) {
			const card = { width: Math.min(370, width - 24), height: 900 };
			const placed = translationCardPosition(
				{ left: 12, right: 56, top: 64, bottom: 108 },
				{ width, height: 640 },
				card,
				"horizontal-tb",
				140,
				placement,
			);
			assert.ok(placed.left >= 12 && placed.left + card.width <= width - 12);
			assert.ok(placed.top >= 64);
			assert.ok(placed.top + Math.min(card.height, placed.maxHeight) <= 500);
			if (width <= 600) assert.equal(placed.top + placed.maxHeight, 500);
		}
	}
});
test("短屏使用实际剩余空间，不越过播放控制区", () => {
	for (const width of [320, 640]) {
		const placed = translationCardPosition(
			null,
			{ width, height: 320 },
			{ width: Math.min(370, width - 24), height: 500 },
			"horizontal-tb",
			180,
		);
		assert.ok(placed.top >= 12);
		assert.ok(placed.top + placed.maxHeight <= 140);
		assert.ok(placed.maxHeight >= 100);
	}
});
test("横排译文避开选区，正文下方不足时放到上方", () => {
	for (const anchor of [
		{ left: 400, right: 600, top: 160, bottom: 190 },
		{ left: 400, right: 600, top: 600, bottom: 630 },
	]) {
		const placed = translationCardPosition(anchor, viewport, size);
		assert.ok(
			placed.top >= anchor.bottom + 8 ||
				placed.top + Math.min(size.height, placed.maxHeight) <= anchor.top - 8,
		);
	}
});
test("竖排优先放在选区左侧，左侧不足时使用右侧", () => {
	for (const anchor of [
		{ left: 900, right: 930, top: 100, bottom: 660 },
		{ left: 40, right: 70, top: 100, bottom: 660 },
	]) {
		const placed = translationCardPosition(
			anchor,
			viewport,
			size,
			"vertical-rl",
		);
		assert.ok(
			placed.left + size.width <= anchor.left - 8 ||
				placed.left >= anchor.right + 8,
		);
		assert.ok(placed.top >= 64 && placed.top + size.height <= 724);
	}
});
test("窄屏底部卡片为播放控制留出空间，长内容限制在视口中", () => {
	for (const width of [320, 390, 600]) {
		const phone = { width, height: 640 };
		const card = { width: width - 24, height: 900 };
		const placed = translationCardPosition(
			null,
			phone,
			card,
			"vertical-rl",
			140,
		);
		assert.equal(placed.left, 12);
		assert.ok(placed.top >= 64);
		assert.equal(placed.top + placed.maxHeight, phone.height - 140);
		assert.ok(placed.maxHeight <= phone.height * 0.6);
	}
});
test("窗口边缘或过期选区不会把卡片推出视口", () => {
	for (const anchor of [
		null,
		{ left: -900, right: -870, top: -200, bottom: -100 },
		{ left: 1200, right: 1270, top: 100, bottom: 760 },
		{ left: 10, right: 1270, top: 80, bottom: 720 },
	]) {
		const placed = translationCardPosition(
			anchor,
			viewport,
			{ ...size, height: 1200 },
			"vertical-rl",
			140,
		);
		assert.ok(
			placed.left >= 12 && placed.left + size.width <= viewport.width - 12,
		);
		assert.ok(
			placed.top >= 64 &&
				placed.top + placed.maxHeight <= viewport.height - 140,
		);
	}
});
