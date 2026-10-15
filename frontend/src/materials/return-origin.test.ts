import assert from "node:assert/strict";
import test from "node:test";
import { atChapterStart, jumpOrigin, samePosition } from "./return-origin.ts";

const beginning = {
	version_id: "v",
	chapter_id: "current",
	part_index: 0,
	resource_id: "r",
	kind: "text" as const,
	offset: 0,
};
const presented = { ...beginning, offset: 360 };
const otherChapter = { ...beginning, chapter_id: "previous", offset: 80 };

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
