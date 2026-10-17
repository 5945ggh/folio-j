import assert from "node:assert/strict";
import test from "node:test";
import { readerWheelScroll } from "./scroll.ts";

const wheel = {
	deltaX: 0,
	deltaY: 120,
	deltaMode: 0,
	ctrlKey: false,
	defaultPrevented: false,
};
const options = {
	vertical: false,
	outside: true,
	lineHeight: 44,
	pageSize: 638,
};

test("outer gutters forward both wheel axes without smoothing trackpad momentum", () => {
	assert.deepEqual(readerWheelScroll(wheel, options), {
		left: 0,
		top: 120,
		behavior: "instant",
	});
	assert.deepEqual(
		readerWheelScroll({ ...wheel, deltaX: -30, deltaY: -5 }, options),
		{ left: -30, top: -5, behavior: "instant" },
	);
	assert.equal(readerWheelScroll(wheel, { ...options, outside: false }), null);
});

test("vertical reading maps vertical gestures equally inside and outside the text", () => {
	for (const outside of [true, false]) {
		for (const deltaY of [120, -120])
			assert.deepEqual(
				readerWheelScroll(
					{ ...wheel, deltaY },
					{ ...options, vertical: true, outside },
				),
				{ left: -deltaY, top: 0, behavior: "instant" },
			);
	}
	const horizontal = { ...wheel, deltaX: -120, deltaY: 5 };
	assert.equal(
		readerWheelScroll(horizontal, {
			...options,
			vertical: true,
			outside: false,
		}),
		null,
	);
	assert.deepEqual(
		readerWheelScroll(horizontal, { ...options, vertical: true }),
		{ left: -120, top: 5, behavior: "instant" },
	);
});

test("forwarded wheel distances honor line and page units", () => {
	assert.equal(
		readerWheelScroll({ ...wheel, deltaY: 3, deltaMode: 1 }, options)?.top,
		132,
	);
	assert.equal(
		readerWheelScroll({ ...wheel, deltaY: -1, deltaMode: 2 }, options)?.top,
		-638,
	);
	assert.equal(
		readerWheelScroll(
			{ ...wheel, deltaY: 1, deltaMode: 2 },
			{ ...options, vertical: true, pageSize: 1216 },
		)?.left,
		-1216,
	);
});

test("zoom, consumed events and stationary gestures never forward", () => {
	for (const event of [
		{ ...wheel, ctrlKey: true },
		{ ...wheel, defaultPrevented: true },
		{ ...wheel, deltaX: 0, deltaY: 0 },
	])
		assert.equal(readerWheelScroll(event, options), null);
});
