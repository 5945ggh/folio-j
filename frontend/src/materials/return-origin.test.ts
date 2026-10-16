import assert from "node:assert/strict";
import test from "node:test";
import {
	atChapterStart,
	JumpReadingSession,
	jumpOrigin,
	samePosition,
} from "./return-origin.ts";

const beginning = {
	version_id: "v",
	chapter_id: "current",
	part_index: 0,
	resource_id: "r",
	kind: "text" as const,
	offset: 0,
	at_chapter_end: false,
};
const presented = { ...beginning, offset: 360 };
const otherChapter = { ...beginning, chapter_id: "previous", offset: 80 };

test("a chain of directory, search and image jumps keeps its first origin", () => {
	const directory = jumpOrigin(null, presented, otherChapter, "preserve");
	const search = jumpOrigin(
		directory.origin,
		otherChapter,
		beginning,
		"preserve",
	);
	const image = jumpOrigin(search.origin, beginning, otherChapter, "preserve");
	assert.equal(directory.jump, true);
	assert.deepEqual(image.origin, presented);
	// Returning consumes the point only after successful restoration in the caller.
	assert.equal(samePosition(image.origin, presented), true);
	assert.deepEqual(
		jumpOrigin(null, otherChapter, beginning, "preserve").origin,
		otherChapter,
	);
});

test("missing presented positions keep an existing return point", () => {
	assert.deepEqual(jumpOrigin(presented, null, beginning, "preserve"), {
		jump: true,
		origin: presented,
	});
});

test("chapter-start undo replaces a previous cross-chapter origin with the current presented position", () => {
	const decision = jumpOrigin(otherChapter, presented, beginning, "replace");
	assert.equal(decision.jump, true);
	assert.deepEqual(decision.origin, presented);
	assert.equal(decision.origin?.chapter_id, "current");
	assert.equal(decision.origin?.offset, 360);
	assert.deepEqual(
		jumpOrigin(otherChapter, presented, beginning, "preserve").origin,
		otherChapter,
	);
});
test("an exact repeated chapter-start action preserves its undo point", () => {
	assert.deepEqual(jumpOrigin(presented, beginning, beginning, "replace"), {
		jump: false,
		origin: presented,
	});
	// Positions that round to 0% still represent distinct anchors.
	assert.equal(
		jumpOrigin(presented, { ...beginning, offset: 1 }, beginning, "replace")
			.jump,
		true,
	);
	assert.equal(samePosition({ ...beginning, part_index: 1 }, beginning), false);
	const image = {
		...beginning,
		kind: "image" as const,
		image_id: 4,
		image_progress: 0,
	};
	assert.equal(samePosition({ ...image, image_progress: 0.001 }, image), false);
	assert.equal(samePosition({ ...image, image_id: 5 }, image), false);
	assert.equal(
		samePosition({ ...beginning, at_chapter_end: false }, beginning),
		true,
	);
	assert.equal(
		samePosition({ ...beginning, at_chapter_end: true }, beginning),
		false,
	);
	assert.equal(samePosition({ ...image, at_chapter_end: true }, image), false);
});

test("a presented chapter start preserves undo despite invisible leading whitespace", () => {
	assert.deepEqual(
		jumpOrigin(
			presented,
			{ ...beginning, offset: 1 },
			beginning,
			"replace",
			true,
		),
		{ jump: false, origin: presented },
	);
	assert.equal(atChapterStart(0, true), true);
	assert.equal(atChapterStart(-0.5, true), true);
	assert.equal(atChapterStart(0, false), false);
	assert.equal(atChapterStart(29.5, true), false);
	assert.equal(atChapterStart(Number.NaN, true), false);
	// Text offset zero can be below an introductory image rather than at the physical start.
	assert.equal(
		jumpOrigin(presented, beginning, beginning, "replace", false).jump,
		true,
	);
	// Being at another chapter's start does not suppress a cross-chapter jump.
	assert.equal(
		jumpOrigin(presented, otherChapter, beginning, "replace", true).jump,
		true,
	);
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

test("confirmed reading replaces only the next accepted jump's origin", () => {
	const session = new JumpReadingSession();
	session.sample(0, 1_000, 0);
	move(session, 500, 100);
	move(session, 1_000, 10_100);
	const next = jumpOrigin(
		session.shouldReplace ? null : otherChapter,
		presented,
		beginning,
		"preserve",
	);
	assert.deepEqual(next.origin, presented);
	assert.equal(session.shouldReplace, true);
	if (next.jump) session.reset();
	assert.equal(session.shouldReplace, false);
	assert.deepEqual(
		jumpOrigin(next.origin, beginning, otherChapter, "preserve").origin,
		presented,
	);
});
