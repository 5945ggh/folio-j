import assert from "node:assert/strict";
import { test } from "node:test";
import {
	draftAfterAcceptance,
	submissionMayHaveSucceeded,
	threadChanged,
} from "./state.ts";

const submitted = {
	request_id: "4f045624-ff68-443d-86a5-4c33db54d411",
	expected_thread_revision: 1,
	expected_segment_revision: 1,
	question: "原问题",
	additional_instructions: "原补充",
	stream: true,
};

test("accepted submission clears only the unchanged submitted draft", () => {
	assert.deepEqual(
		draftAfterAcceptance(
			{ question: "原问题", additional: "原补充" },
			submitted,
		),
		{ question: "", additional: "" },
	);
	assert.deepEqual(
		draftAfterAcceptance(
			{ question: "下一轮问题", additional: "原补充" },
			submitted,
		),
		{ question: "下一轮问题", additional: "原补充" },
	);
	assert.deepEqual(
		draftAfterAcceptance(
			{ question: "原问题", additional: "新补充" },
			submitted,
		),
		{ question: "原问题", additional: "新补充" },
	);
});

test("server failures and lost responses require checking the same submission", () => {
	assert.equal(submissionMayHaveSucceeded({ status: 500 }), true);
	assert.equal(submissionMayHaveSucceeded({ status: 502 }), true);
	assert.equal(
		submissionMayHaveSucceeded(new TypeError("Failed to fetch")),
		true,
	);
	assert.equal(submissionMayHaveSucceeded({ status: 0 }), true);
	assert.equal(submissionMayHaveSucceeded({ status: 409 }), false);
	assert.equal(submissionMayHaveSucceeded({ status: 422 }), false);
});

test("thread revision and active job transitions refresh persisted history", () => {
	const idle = { revision: 1, active_job_id: null };
	assert.equal(threadChanged(null, idle), false);
	assert.equal(threadChanged(idle, idle), false);
	assert.equal(
		threadChanged(
			{ revision: 2, active_job_id: "job" },
			{ revision: 3, active_job_id: null },
		),
		true,
	);
	assert.equal(threadChanged(idle, { revision: 3, active_job_id: null }), true);
});
