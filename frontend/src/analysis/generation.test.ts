import assert from "node:assert/strict";
import test from "node:test";
import { generationResult, isTerminalJob } from "../chat/discussion.ts";

test("generation remains busy through review and stopping, until a persistent terminal status", () => {
	for (const status of [
		"queued",
		"running",
		"waiting_review",
		"stopping",
	] as const) {
		assert.equal(isTerminalJob({ status }), false);
		assert.equal(generationResult({ status, artifacts: [] }), "none");
	}
	for (const status of ["succeeded", "failed", "interrupted"] as const)
		assert.equal(isTerminalJob({ status }), true);
});

test("unfinished reply feedback preserves exact saved artifact identity", () => {
	const artifacts = [
		{ analysis_id: "analysis-a", revision_id: "revision-old" },
	];
	for (const status of ["failed", "interrupted"] as const) {
		assert.equal(
			generationResult({ status, artifacts }),
			"saved_with_unfinished_reply",
		);
		assert.equal(generationResult({ status, artifacts: [] }), "not_saved");
	}
	assert.deepEqual(artifacts, [
		{ analysis_id: "analysis-a", revision_id: "revision-old" },
	]);
});
