import type { QueryClient } from "@tanstack/react-query";
import type { Job, JobInput, Thread } from "./api.ts";

export type Draft = { question: string; additional: string };
export type PendingSubmission = { input: JobInput; uncertain: boolean };
export type ReadingPosition = {
	analysisId: string | null;
	revisionId: string | null;
};

export const terminalJobStatuses = new Set<Job["status"]>([
	"succeeded",
	"failed",
	"interrupted",
]);

const jobKey = (jobId: string) => ["chat-job", jobId] as const;

export function mergeJob(client: QueryClient, job: Job): Job {
	const cached = client.getQueryData<Job>(jobKey(job.id));
	const current = freshestJob(cached, job);
	if (current !== cached) client.setQueryData(jobKey(job.id), current);
	return current;
}

export function isTerminalJob(job: Pick<Job, "status">): boolean {
	return terminalJobStatuses.has(job.status);
}

export function freshestJob<T extends Pick<Job, "version">>(
	cached: T | undefined,
	incoming: T,
): T {
	return cached && cached.version >= incoming.version ? cached : incoming;
}

export function draftAfterAcceptance(
	current: Draft,
	submitted: JobInput,
): Draft {
	return current.question === submitted.question &&
		current.additional === submitted.additional_instructions
		? { question: "", additional: "" }
		: current;
}

export function acceptedDraft(current: Draft, submitted: JobInput): Draft {
	return submitted.action === "generate_analysis"
		? current
		: draftAfterAcceptance(current, submitted);
}

export function submissionMayHaveSucceeded(error: unknown): boolean {
	if (error && typeof error === "object" && "status" in error) {
		const status = error.status;
		return typeof status !== "number" || status === 0 || status >= 500;
	}
	return true;
}

export function threadChanged(
	previous: Pick<Thread, "revision" | "active_job_id"> | null,
	current: Pick<Thread, "revision" | "active_job_id">,
): boolean {
	return (
		previous !== null &&
		(current.revision > previous.revision ||
			previous.active_job_id !== current.active_job_id)
	);
}

export function usableThread<T extends { segment_id: string }>(
	thread: T | undefined,
	segmentId: string,
	isSuccess: boolean,
): T | null {
	return isSuccess && thread?.segment_id === segmentId ? thread : null;
}

export function savedArtifact(
	job: Pick<Job, "artifacts">,
): { analysisId: string; revisionId: string } | null {
	const artifact = job.artifacts?.find(
		(item) => item.analysis_id && item.revision_id,
	);
	return artifact?.analysis_id && artifact.revision_id
		? { analysisId: artifact.analysis_id, revisionId: artifact.revision_id }
		: null;
}

export function shouldOpenArtifact(
	expected: ReadingPosition | undefined,
	current: ReadingPosition,
): boolean {
	return (
		!expected ||
		(expected.analysisId === current.analysisId &&
			expected.revisionId === current.revisionId)
	);
}

export function captureReadingPosition(
	positions: Record<string, ReadingPosition>,
	requestId: string,
	position: ReadingPosition,
): Record<string, ReadingPosition> {
	return positions[requestId]
		? positions
		: { ...positions, [requestId]: position };
}

export function readingPositionForJob(
	byJob: Record<string, ReadingPosition>,
	byRequest: Record<string, ReadingPosition>,
	job: Pick<Job, "id" | "request_id">,
): ReadingPosition | undefined {
	return byJob[job.id] ?? byRequest[job.request_id];
}

export function generationResult(
	job: Pick<Job, "status" | "artifacts">,
): "saved_with_unfinished_reply" | "not_saved" | "none" {
	if (job.status !== "failed" && job.status !== "interrupted") return "none";
	return savedArtifact(job) ? "saved_with_unfinished_reply" : "not_saved";
}

type SubmissionApi = {
	submit: (threadId: string, input: JobInput) => Promise<Job>;
	findByRequest: (threadId: string, requestId: string) => Promise<Job>;
};

export type AcceptanceCallbacks = {
	threadId: string;
	segmentId: string;
	input: JobInput;
	setRecentJobId: (jobId: string) => void;
	setPending: (pending: PendingSubmission | null) => void;
	setDraft: (update: (current: Draft) => Draft) => void;
	setError: (error: Error | null) => void;
	onJobAccepted: (job: Job) => void;
	onGenerationAccepted: (job: Job) => void;
};

export type JobCallbacks = {
	threadId: string;
	segmentId: string;
	onArtifact: (analysisId: string, revisionId: string, job: Job) => void;
};

export class DiscussionCoordinator {
	private readonly seenTerminalJobIds = new Set<string>();
	private readonly client: QueryClient;
	private readonly api: SubmissionApi;

	constructor(client: QueryClient, api: SubmissionApi) {
		this.client = client;
		this.api = api;
	}

	accept(job: Job) {
		return { job: this.merge(job), pending: null };
	}

	async submit(threadId: string, input: JobInput) {
		try {
			return this.accept(await this.api.submit(threadId, input));
		} catch (error) {
			if (submissionMayHaveSucceeded(error))
				return {
					job: null,
					pending: { input, uncertain: true } satisfies PendingSubmission,
					error,
				};
			return { job: null, pending: null, error };
		}
	}

	async verify(threadId: string, pending: PendingSubmission) {
		return this.accept(
			await this.api.findByRequest(threadId, pending.input.request_id),
		);
	}

	acceptSubmission(job: Job, callbacks: AcceptanceCallbacks) {
		const current = this.merge(job);
		callbacks.setRecentJobId(current.id);
		callbacks.setPending(null);
		callbacks.onJobAccepted(current);
		if (callbacks.input.action === "generate_analysis")
			callbacks.onGenerationAccepted(current);
		else callbacks.setDraft((draft) => acceptedDraft(draft, callbacks.input));
		callbacks.setError(null);
		void this.client.invalidateQueries({
			queryKey: ["chat-thread", callbacks.threadId],
		});
		void this.client.invalidateQueries({
			queryKey: ["chat-messages", callbacks.threadId],
		});
		void this.client.invalidateQueries({
			queryKey: ["chat-threads", callbacks.segmentId],
		});
		void this.client.invalidateQueries({
			queryKey: ["segment", callbacks.segmentId],
		});
		return current;
	}

	observeJob(job: Job, callbacks: JobCallbacks) {
		const current = this.merge(job);
		const notify =
			isTerminalJob(current) && !this.seenTerminalJobIds.has(current.id);
		if (!notify) return { job: current, notify: false };
		this.seenTerminalJobIds.add(current.id);
		void this.client.invalidateQueries({
			queryKey: ["chat-thread", callbacks.threadId],
		});
		void this.client.invalidateQueries({
			queryKey: ["chat-messages", callbacks.threadId],
		});
		void this.client.invalidateQueries({
			queryKey: ["chat-threads", callbacks.segmentId],
		});
		void this.client.invalidateQueries({
			queryKey: ["segment", callbacks.segmentId],
		});
		void this.client.invalidateQueries({
			queryKey: ["analyses", callbacks.segmentId],
		});
		void this.client.invalidateQueries({ queryKey: ["analysis"] });
		const artifact = savedArtifact(current);
		if (artifact && current.kind !== "generate_analysis")
			callbacks.onArtifact(artifact.analysisId, artifact.revisionId, current);
		return { job: current, notify: true };
	}

	merge(job: Job) {
		return mergeJob(this.client, job);
	}
}
