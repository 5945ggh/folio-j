import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type Job, stopJob } from "../chat/api";
import { generationResult, isTerminalJob, mergeJob } from "../chat/discussion";
import { InlineError } from "../Shared";

export function AnalysisGenerationStatus({
	job,
	onSelect,
}: {
	job: Job;
	onSelect: (analysisId: string | null, revisionId: string | null) => void;
}) {
	const client = useQueryClient();
	const stop = useMutation({
		mutationFn: (jobId: string) => stopJob(jobId),
		onSuccess: (updated) => mergeJob(client, updated),
	});
	return (
		<>
			{!isTerminalJob(job) && (
				<section className="analysis-draft" aria-label="尚未保存的讲解">
					<div className="analysis-draft-header">
						<span>
							{job.status === "stopping" ? "正在停止" : "生成中"} · 尚未保存
						</span>
						<button
							type="button"
							className="analysis-quiet-button"
							disabled={stop.isPending || job.status === "stopping"}
							onClick={() => stop.mutate(job.id)}
						>
							停止
						</button>
					</div>
					<InlineError error={stop.error} />
					{job.assistant_message.content ? (
						<pre>{job.assistant_message.content}</pre>
					) : (
						<p>正在准备讲解内容，完成后会自动保存并打开。</p>
					)}
				</section>
			)}
			{generationResult(job) === "saved_with_unfinished_reply" && (
				<div className="analysis-generation-result" role="status">
					讲解已保存，后续回答未完成。
					{job.artifacts?.map((artifact) => (
						<button
							key={`${artifact.analysis_id}-${artifact.revision_id}`}
							type="button"
							className="analysis-quiet-button"
							title={`讲解 ${artifact.analysis_id} · 修订 ${artifact.revision_id}`}
							onClick={() =>
								onSelect(artifact.analysis_id, artifact.revision_id)
							}
						>
							打开已保存讲解 · 修订 {artifact.revision_id.slice(-6)}
						</button>
					))}
				</div>
			)}
			{generationResult(job) === "not_saved" && (
				<p className="analysis-generation-result" role="status">
					{job.status === "failed" ? "讲解生成失败" : "讲解生成已停止"}
					；尚未保存新讲解。{job.error || "可重新发起。"}
				</p>
			)}
		</>
	);
}
