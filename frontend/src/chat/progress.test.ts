import assert from "node:assert/strict";
import { test } from "node:test";
import type { Job } from "./api.ts";
import {
	formatElapsed,
	replyElapsedSeconds,
	replyProgressLabel,
} from "./progress.ts";

test("仅以当前活动上报展示模型和工具阶段，历史或未知阶段不推断", () => {
	const running = { status: "running", runs: [] } satisfies Pick<
		Job,
		"status" | "runs"
	>;
	for (const [active_step, label] of Object.entries({
		model_call: "等待模型回复",
		streaming: "正在接收回复",
		writing_analysis: "正在撰写讲解",
		saving_analysis: "正在保存讲解",
		reading_analysis: "正在查阅讲解",
		preparing_edit: "正在准备讲解修改",
		applying_review: "正在保存已同意的修改",
		tool_dispatch: "正在处理本轮请求",
		answering: "正在处理本轮请求",
		unknown: "正在处理本轮请求",
	}))
		assert.equal(replyProgressLabel({ ...running, active_step }), label);
	assert.equal(replyProgressLabel(running), "正在处理本轮请求");
	assert.equal(
		replyProgressLabel({ ...running, active_step: "saving_analysis" }).includes(
			"已保存",
		),
		false,
	);
});

test("审核、停止和终态优先于残留活动，查询失败不将旧活动说成当前", () => {
	const labels = {
		queued: "排队中",
		waiting_review: "等待你审核修改",
		stopping: "正在停止本轮",
		succeeded: "已完成",
		failed: "本轮失败",
		interrupted: "本轮已中断",
	} as const;
	for (const [status, label] of Object.entries(labels))
		assert.equal(
			replyProgressLabel({
				status: status as Job["status"],
				active_step: "streaming",
			}),
			label,
		);
	assert.equal(
		replyProgressLabel({ status: "running", active_step: "streaming" }, true),
		"状态暂未更新，正在重试",
	);
	assert.equal(replyProgressLabel({ status: "succeeded" }, true), "已完成");
});

test("多轮等待只统计真实聊天 Run，工具阶段不显示旧轮次", () => {
	const job = {
		status: "running",
		active_step: "model_call",
		runs: [
			{ id: "1", purpose: "chat", status: "succeeded" },
			{ id: "2", purpose: "chat", status: "running" },
			{ id: "other", purpose: "validation", status: "succeeded" },
		],
	} satisfies Pick<Job, "status" | "active_step" | "runs">;
	assert.equal(replyProgressLabel(job), "等待模型继续回复");
	assert.equal(
		replyProgressLabel({ ...job, active_step: "reading_analysis" }),
		"正在查阅讲解",
	);
});

test("提交审核决定与停止请求期间显示真实提交动作，终态不回退", () => {
	assert.equal(
		replyProgressLabel({ status: "waiting_review" }, false, "decision"),
		"正在提交审核决定",
	);
	assert.equal(
		replyProgressLabel({ status: "running" }, false, "stop"),
		"正在提交停止请求",
	);
	assert.equal(
		replyProgressLabel({ status: "interrupted" }, false, "stop"),
		"本轮已中断",
	);
});

test("已用时间由受理与终态时间计算，含排队和审核且终态停止计时", () => {
	const job = {
		created_at: "2026-10-31T00:00:00Z",
		finished_at: null,
		status: "queued",
	} satisfies Pick<Job, "created_at" | "finished_at" | "status">;
	const now = Date.parse("2026-10-31T00:01:12Z");
	assert.equal(replyElapsedSeconds(job, now), 72);
	assert.equal(
		replyElapsedSeconds({ ...job, status: "waiting_review" }, now),
		72,
	);
	const finished = {
		...job,
		status: "succeeded" as const,
		finished_at: "2026-10-31T00:00:12Z",
	};
	assert.equal(replyElapsedSeconds(finished, now), 12);
	assert.equal(replyElapsedSeconds(finished, now + 90000), 12);
	assert.equal(
		replyElapsedSeconds({ ...finished, finished_at: null }, now),
		null,
	);
	assert.equal(
		replyElapsedSeconds({ ...job, created_at: "invalid" }, now),
		null,
	);
	assert.equal(replyElapsedSeconds(job, Date.parse(job.created_at) - 2000), 0);
	assert.equal(formatElapsed(0), "0:00");
	assert.equal(formatElapsed(72), "1:12");
	assert.equal(formatElapsed(3602), "1:00:02");
});
