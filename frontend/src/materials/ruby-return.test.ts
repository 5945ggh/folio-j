import assert from "node:assert/strict";
import test from "node:test";
import type { Position } from "./api";
import { returnWasLocated } from "./return-recovery.ts";

const target: Position = {
	version_id: "v",
	chapter_id: "c",
	part_index: 0,
	resource_id: "r",
	kind: "text",
	offset: 42,
	at_chapter_end: false,
	settings: { font_size: 22, line_height: 2, writing_mode: "horizontal-tb" },
};
test("return origin is consumed only for a located target in the current surface generation", () => {
	const intent = { generation: 3, target };
	assert.equal(returnWasLocated(intent, 3, target, false), false);
	assert.equal(returnWasLocated(intent, 4, target, true), false);
	assert.equal(returnWasLocated(intent, 3, null, true), false);
	assert.equal(
		returnWasLocated(intent, 3, { ...target, offset: 43 }, true),
		false,
	);
	assert.equal(
		returnWasLocated(
			intent,
			3,
			{
				...target,
				settings: {
					font_size: 28,
					line_height: 2,
					writing_mode: "horizontal-tb",
				},
			},
			true,
		),
		true,
	);
});
test("an image return requires the intended image rather than a nearby part or text anchor", () => {
	const image: Position = {
		...target,
		kind: "image",
		image_id: 7,
		image_progress: 0.5,
	};
	const intent = { generation: 3, target: image };
	assert.equal(
		returnWasLocated(intent, 3, { ...image, image_id: 8 }, true),
		false,
	);
	assert.equal(returnWasLocated(intent, 3, target, true), false);
	assert.equal(returnWasLocated(intent, 3, image, true), true);
});
