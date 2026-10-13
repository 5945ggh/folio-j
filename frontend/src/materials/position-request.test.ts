import assert from "node:assert/strict";
import test from "node:test";
import type { components } from "../api/schema";
import { positionRequest } from "./position-request.ts";

test("saved response metadata is removed at the position update boundary", () => {
	const saved: components["schemas"]["ReadingPositionResponse"] = {
		version_id: "v",
		chapter_id: "c",
		part_index: 0,
		resource_id: "r",
		kind: "text",
		offset: 80,
		revision: 5,
		updated_at: "2026-10-11T00:00:00Z",
		progress: 0.8,
		settings: {
			font_size: 20,
			line_height: 1.7,
			writing_mode: "horizontal-tb",
		},
	};
	const request = JSON.parse(JSON.stringify(positionRequest(saved, 6)));
	assert.deepEqual(request, {
		version_id: "v",
		chapter_id: "c",
		part_index: 0,
		resource_id: "r",
		kind: "text",
		offset: 80,
		settings: {
			font_size: 20,
			line_height: 1.7,
			writing_mode: "horizontal-tb",
		},
		expected_revision: 6,
	});
});
