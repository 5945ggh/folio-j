import assert from "node:assert/strict";
import test from "node:test";
import {
	clampReaderCardPosition,
	readerCardDragPosition,
	readerCardKeyPosition,
} from "./reader-card-drag.ts";

const bounds = { left: 12, right: 618, top: 64, bottom: 724 };
const size = { width: 370, height: 250 };

test("标题栏轻点不会停驻，越过阈值后按起点移动且边缘可达", () => {
	const start = { x: 100, y: 120, left: 220, top: 200 };
	assert.equal(readerCardDragPosition(start, { x: 103, y: 122 }, false), null);
	assert.deepEqual(readerCardDragPosition(start, { x: 105, y: 120 }, false), {
		left: 225,
		top: 200,
	});
	assert.deepEqual(readerCardDragPosition(start, { x: 101, y: 120 }, true), {
		left: 221,
		top: 200,
	});
	assert.deepEqual(
		clampReaderCardPosition({ left: 900, top: -20 }, bounds, size.height),
		{ left: 618, top: 64 },
	);
	assert.deepEqual(
		clampReaderCardPosition({ left: 220, top: 900 }, bounds, size.height),
		{ left: 220, top: 474 },
	);
});

test("内容变高或视口收窄时重新限制位置，标题栏和关闭按钮留在可用区", () => {
	assert.deepEqual(
		clampReaderCardPosition({ left: 610, top: 450 }, bounds, 600),
		{ left: 610, top: 124 },
	);
	assert.deepEqual(
		clampReaderCardPosition(
			{ left: 610, top: 450 },
			{ left: 12, right: 318, top: 12, bottom: 320 },
			900,
		),
		{ left: 318, top: 12 },
	);
	assert.deepEqual(
		clampReaderCardPosition(
			{ left: 300, top: 1000 },
			{ ...bounds, bottom: 824 },
			520,
		),
		{ left: 300, top: 304 },
	);
});

test("方向键提供等价移动，Shift加快，其他按键不改变位置", () => {
	const position = { left: 220, top: 200 };
	assert.deepEqual(readerCardKeyPosition(position, "ArrowLeft", false), {
		left: 210,
		top: 200,
	});
	assert.deepEqual(readerCardKeyPosition(position, "ArrowDown", true), {
		left: 220,
		top: 240,
	});
	assert.equal(readerCardKeyPosition(position, "Enter", false), null);
});
