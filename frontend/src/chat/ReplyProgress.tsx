import { useEffect, useState } from "react";
import type { Job } from "./api";
import { isTerminalJob } from "./discussion";
import {
	formatElapsed,
	type ReplyOperation,
	replyElapsedSeconds,
	replyProgressLabel,
} from "./progress";

export function ReplyProgress({
	job,
	updateFailed = false,
	operation,
}: {
	job: Job;
	updateFailed?: boolean;
	operation?: ReplyOperation;
}) {
	// Keep clock ticks within this component so Markdown is not rendered again.
	const [now, setNow] = useState(Date.now);
	const terminal = isTerminalJob(job);
	useEffect(() => {
		if (terminal) return;
		const interval = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(interval);
	}, [terminal]);
	const elapsed = replyElapsedSeconds(job, Math.max(now, Date.now()));
	return (
		<div className="chat-reply-progress" data-status={job.status}>
			<span role="status" aria-live="polite" aria-atomic="true">
				{replyProgressLabel(job, updateFailed, operation)}
			</span>
			{elapsed !== null && (
				<span
					className="chat-reply-elapsed"
					aria-live="off"
					title="从请求受理起计算，包含排队和审核等待时间"
				>
					已用 {formatElapsed(elapsed)}
				</span>
			)}
		</div>
	);
}
