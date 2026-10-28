import assert from "node:assert/strict";
import test from "node:test";
import { isTerminalJob, savedArtifact } from "../chat/discussion.ts";

test("普通Job在审核与停止过程仍未终止，只有持久终态才结束", () => {
	for (const status of [
		"queued",
		"running",
		"waiting_review",
		"stopping",
	] as const)
		assert.equal(isTerminalJob({ status }), false);
	for (const status of ["succeeded", "failed", "interrupted"] as const)
		assert.equal(isTerminalJob({ status }), true);
});

test("对话收尾失败不丢失本地保存成果的确切身份", () => {
	const artifacts = [
		{ analysis_id: "analysis-a", revision_id: "revision-old" },
	];
	for (const status of ["succeeded", "failed", "interrupted"] as const) {
		const job = { status, artifacts };
		assert.deepEqual(savedArtifact(job), {
			analysisId: "analysis-a",
			revisionId: "revision-old",
		});
	}
	assert.equal(savedArtifact({ artifacts: [] }), null);
});
