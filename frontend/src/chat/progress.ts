import type { Job } from "./api.ts";
import { isTerminalJob } from "./discussion.ts";

const activityLabels: Record<string, string> = {
	model_call: "等待模型回复",
	streaming: "正在接收回复",
	writing_analysis: "正在撰写讲解",
	saving_analysis: "正在保存讲解",
	reading_analysis: "正在查阅讲解",
	preparing_edit: "正在准备讲解修改",
	applying_review: "正在保存已同意的修改",
};
export type ReplyOperation = "decision" | "stop";

export function replyProgressLabel(
	job: Pick<Job, "status" | "active_step" | "runs">,
	updateFailed = false,
	operation?: ReplyOperation,
): string {
	if (!isTerminalJob(job)) {
		if (operation === "decision") return "正在提交审核决定";
		if (operation === "stop") return "正在提交停止请求";
	}
	if (updateFailed && !isTerminalJob(job)) return "状态暂未更新，正在重试";
	switch (job.status) {
		case "queued":
			return "排队中";
		case "waiting_review":
			return "等待你审核修改";
		case "stopping":
			return "正在停止本轮";
		case "succeeded":
			return "已完成";
		case "failed":
			return "本轮失败";
		case "interrupted":
			return "本轮已中断";
		case "running": {
			// Older jobs may retain a completed tool step or text from an earlier
			// invocation. Only the explicit current activity describes a stage.
			const activity = activityLabels[job.active_step ?? ""];
			if (!activity) return "正在处理本轮请求";
			const calls =
				job.runs?.filter((run) => run.purpose === "chat").length ?? 0;
			return calls > 1 && job.active_step === "model_call"
				? "等待模型继续回复"
				: activity;
		}
	}
}

export function replyElapsedSeconds(
	job: Pick<Job, "created_at" | "finished_at" | "status">,
	now: number,
): number | null {
	const start = Date.parse(job.created_at);
	// Missing terminal timestamps must not leave a completed task's clock running.
	const end = isTerminalJob(job)
		? job.finished_at
			? Date.parse(job.finished_at)
			: Number.NaN
		: now;
	return Number.isFinite(start) && Number.isFinite(end)
		? Math.max(0, Math.floor((end - start) / 1000))
		: null;
}

export function formatElapsed(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	const remainder = String(seconds % 60).padStart(2, "0");
	return minutes < 60
		? `${minutes}:${remainder}`
		: `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${remainder}`;
}
