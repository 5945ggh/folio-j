import assert from "node:assert/strict";
import { test } from "node:test";
import {
	draftAfterAcceptance,
	submissionMayHaveSucceeded,
	threadChanged,
	usableThread,
} from "./state.ts";

test("普通对话只使用成功加载且属于当前片段的线程", () => {
	const current = { id: "t", segment_id: "s" };
	assert.equal(usableThread(current, "s", true), current);
	assert.equal(usableThread(current, "other", true), null);
	assert.equal(usableThread(current, "s", false), null);
	assert.equal(usableThread(undefined, "s", false), null);
});

const submitted = {
	request_id: "4f045624-ff68-443d-86a5-4c33db54d411",
	expected_thread_revision: 1,
	expected_segment_revision: 1,
	question: "原问题",
	stream: true,
};

test("accepted submission clears only the unchanged submitted draft", () => {
	assert.deepEqual(draftAfterAcceptance({ question: "原问题" }, submitted), {
		question: "",
	});
	assert.deepEqual(
		draftAfterAcceptance({ question: "下一轮问题" }, submitted),
		{ question: "下一轮问题" },
	);
	assert.deepEqual(
		draftAfterAcceptance({ question: "原问题\n\n新补充" }, submitted),
		{ question: "原问题\n\n新补充" },
	);
});

test("已合入正文的历史补充在原样提交后清空，编辑后保留", () => {
	const question = "原问题\n\n  保留例句\n只讲语气  ";
	const input = { ...submitted, question };
	assert.deepEqual(draftAfterAcceptance({ question }, input), { question: "" });
	const edited = { question: `${question}\n只分析这一句` };
	assert.equal(draftAfterAcceptance(edited, input), edited);
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
