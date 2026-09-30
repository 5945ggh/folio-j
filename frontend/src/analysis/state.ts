import type { Job } from "../chat/api";

export function generationResult(
	job: Pick<Job, "status" | "artifacts">,
): "saved_with_unfinished_reply" | "not_saved" | "none" {
	if (job.status !== "failed" && job.status !== "interrupted") return "none";
	return job.artifacts?.some((item) => item.analysis_id && item.revision_id)
		? "saved_with_unfinished_reply"
		: "not_saved";
}

export function readingAnalysis<T extends { id: string; segment_id: string }>(
	detail: T | undefined,
	segmentId: string,
	selectedId: string | null,
	isError = false,
): T | null {
	return !isError &&
		selectedId &&
		detail?.id === selectedId &&
		detail.segment_id === segmentId
		? detail
		: null;
}
