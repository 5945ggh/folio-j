import assert from "node:assert/strict";
import test from "node:test";
import { JumpReadingSession, returnOriginLabel } from "./return-origin.ts";

test("return label names the destination and rounds its chapter progress", () => {
	assert.equal(returnOriginLabel("第一章", 0.424), "返回“第一章 42%”");
	assert.equal(returnOriginLabel("第一章", 0.426), "返回“第一章 43%”");
	assert.equal(returnOriginLabel("第一章", 0), "返回“第一章 0%”");
	assert.equal(returnOriginLabel("第一章", 1), "返回“第一章 100%”");
	assert.equal(returnOriginLabel("挿絵", null), "返回“挿絵”");
});

function move(
	session: JumpReadingSession,
	offset: number,
	now: number,
	viewport = 1_000,
) {
	session.input(now);
	session.sample(offset, viewport, now);
}

test("continued active reading needs a viewport and at least five seconds between actual movements", () => {
	const session = new JumpReadingSession();
	session.sample(0, 1_000, 0);
	move(session, 500, 100);
	move(session, 1_000, 5_099);
	assert.equal(session.shouldReplace, false);
	move(session, 1_001, 5_100);
	assert.equal(session.shouldReplace, true);
});

test("a delayed first movement and a quick viewport followed by stillness do not confirm reading", () => {
	const session = new JumpReadingSession();
	session.sample(0, 1_000, 0);
	move(session, 1_000, 20_000);
	assert.equal(session.shouldReplace, false);
	session.sample(1_000, 1_000, 30_000);
	session.input(40_000);
	session.sample(1_000, 1_000, 40_000);
	assert.equal(session.shouldReplace, false);
});

test("short micro-scrolls and elapsed time without enough distance do not confirm reading", () => {
	const session = new JumpReadingSession();
	session.sample(0, 1_000, 0);
	move(session, 10, 100);
	move(session, 20, 10_100);
	move(session, 30, 20_100);
	assert.equal(session.shouldReplace, false);
});

test("backtracking cancels forward distance and returning to the start restarts its clock", () => {
	const session = new JumpReadingSession();
	session.sample(0, 1_000, 0);
	move(session, 600, 100);
	move(session, 300, 5_000);
	move(session, 700, 10_100);
	assert.equal(session.shouldReplace, false);
	move(session, 0, 11_000);
	move(session, 1_000, 12_000);
	assert.equal(session.shouldReplace, false);
	move(session, 1_001, 22_000);
	assert.equal(session.shouldReplace, true);
});

test("input grants at most an 800 ms sample window and passive moves update the baseline", () => {
	const session = new JumpReadingSession();
	session.sample(0, 1_000, 0);
	session.input(100);
	session.sample(400, 1_000, 900);
	// This movement falls outside the same input's window.
	session.sample(1_000, 1_000, 901);
	move(session, 1_100, 11_000);
	assert.equal(session.shouldReplace, false);
	move(session, 1_600, 12_000);
	assert.equal(session.shouldReplace, true);
});

test("programmatic position changes cannot supply active reading distance", () => {
	const session = new JumpReadingSession();
	session.sample(0, 1_000, 0);
	session.sample(10_000, 1_000, 100);
	move(session, 10_400, 1_000);
	session.sample(20_000, 1_000, 5_000);
	move(session, 20_500, 11_000);
	assert.equal(session.shouldReplace, false);
	move(session, 20_600, 12_000);
	assert.equal(session.shouldReplace, true);
});

test("normal reading pauses count but a gap greater than two minutes starts a new candidate", () => {
	const session = new JumpReadingSession();
	session.sample(0, 1_000, 0);
	move(session, 500, 100);
	move(session, 1_000, 120_101);
	assert.equal(session.shouldReplace, false);
	move(session, 1_500, 130_101);
	assert.equal(session.shouldReplace, true);
	const boundary = new JumpReadingSession();
	boundary.sample(0, 1_000, 0);
	move(boundary, 500, 100);
	move(boundary, 1_000, 120_100);
	assert.equal(boundary.shouldReplace, true);
});

test("pause discards unfinished evidence, input eligibility and the old layout baseline", () => {
	const session = new JumpReadingSession();
	session.sample(0, 1_000, 0);
	move(session, 500, 100);
	session.pause();
	session.input(10_100);
	// A new stable layout's first sample supplies a baseline only.
	session.sample(10_000, 1_000, 10_100);
	assert.equal(session.shouldReplace, false);
	session.pause();
	session.sample(20_000, 1_000, 10_200);
	session.sample(21_000, 1_000, 10_300);
	assert.equal(session.shouldReplace, false);
	move(session, 21_500, 20_000);
	move(session, 22_000, 30_000);
	assert.equal(session.shouldReplace, true);
});

test("confirmed reading survives pause and only reset starts a fresh jump chain", () => {
	const session = new JumpReadingSession();
	session.sample(0, 1_000, 0);
	move(session, 500, 100);
	move(session, 1_000, 10_100);
	assert.equal(session.shouldReplace, true);
	session.pause();
	assert.equal(session.shouldReplace, true);
	session.sample(0, 0, 20_000);
	assert.equal(session.shouldReplace, true);
	session.reset();
	assert.equal(session.shouldReplace, false);
	move(session, 5_000, 30_000);
	assert.equal(session.shouldReplace, false);
	move(session, 5_500, 40_000);
	assert.equal(session.shouldReplace, false);
	move(session, 6_000, 50_000);
	assert.equal(session.shouldReplace, true);
});

test("invalid positions, viewports and reversed time cannot supply reading evidence", () => {
	for (const viewport of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		const session = new JumpReadingSession();
		session.sample(0, 1_000, 0);
		move(session, 500, 100);
		move(session, 10_000, 10_100, viewport);
		assert.equal(session.shouldReplace, false);
		move(session, 10_500, 20_100);
		assert.equal(session.shouldReplace, false);
	}
	const session = new JumpReadingSession();
	session.sample(0, 1_000, 0);
	move(session, 500, 100);
	move(session, Number.NaN, 10_100);
	move(session, 10_000, 20_100);
	assert.equal(session.shouldReplace, false);
	move(session, 10_500, 30_100);
	move(session, 11_000, 30_000);
	assert.equal(session.shouldReplace, false);
	move(session, 11_500, 40_100);
	assert.equal(session.shouldReplace, false);
	session.input(Number.NaN);
	session.sample(12_000, 1_000, 40_200);
	assert.equal(session.shouldReplace, false);
});

test("normalized vertical and horizontal reading axes follow the same policy", () => {
	for (const direction of [1, -1]) {
		const session = new JumpReadingSession();
		const physicalOffset = (progress: number) => progress * direction;
		const readingOffset = (progress: number) =>
			physicalOffset(progress) * direction;
		session.sample(readingOffset(0), 1_000, 0);
		move(session, readingOffset(500), 100);
		move(session, readingOffset(1_000), 10_100);
		assert.equal(session.shouldReplace, true);
	}
});
