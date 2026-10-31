import type { Job, JobInput, Thread } from "./api.ts";
import type { DiscussionCoordinator } from "./discussion.ts";

type SubmissionResult = Awaited<ReturnType<DiscussionCoordinator["submit"]>>;
export type ExplanationProgress =
	| "prompt"
	| "thread"
	| "checking"
	| "submitting";
type Dependencies = {
	readPrompt: () => Promise<{ question: string }>;
	createThread: (requestId: string, modelId: string) => Promise<Thread>;
	submit: (threadId: string, input: JobInput) => Promise<SubmissionResult>;
	findByRequest: (threadId: string, requestId: string) => Promise<Job>;
	onProgress?: (token: string, progress: ExplanationProgress) => void;
};
type Result = {
	item: Thread;
	question: string;
	token: string;
	input: JobInput;
	result: SubmissionResult;
};

/** Each click completes independently of which conversation is currently visible. */
export class ExplanationRequests {
	private readonly requests = new Map<
		string,
		{
			modelId: string;
			segmentRevision: number;
			question?: string;
			item?: Thread;
			input?: JobInput;
			pending?: Promise<Result>;
		}
	>();
	private readonly dependencies: Dependencies;
	constructor(dependencies: Dependencies) {
		this.dependencies = dependencies;
	}

	start(token: string, modelId: string, segmentRevision: number) {
		let request = this.requests.get(token);
		if (!request) {
			request = { modelId, segmentRevision };
			this.requests.set(token, request);
		}
		if (request.pending) return request.pending;
		const frozen = request;
		const pending = (async () => {
			if (frozen.question === undefined) {
				this.dependencies.onProgress?.(token, "prompt");
				frozen.question = (await this.dependencies.readPrompt()).question;
			}
			if (!frozen.item) {
				this.dependencies.onProgress?.(token, "thread");
				frozen.item = await this.dependencies.createThread(
					token,
					frozen.modelId,
				);
			}
			frozen.input ??= {
				request_id: token,
				expected_thread_revision: frozen.item.revision,
				expected_segment_revision: frozen.segmentRevision,
				question: frozen.question,
				stream: true,
			};
			let existing: Job | null = null;
			this.dependencies.onProgress?.(token, "checking");
			try {
				existing = await this.dependencies.findByRequest(frozen.item.id, token);
			} catch (error) {
				if (
					!error ||
					typeof error !== "object" ||
					!("status" in error) ||
					error.status !== 404
				)
					throw error;
			}
			if (existing) {
				frozen.question = existing.question;
				frozen.input = { ...frozen.input, question: existing.question };
			}
			if (!existing) this.dependencies.onProgress?.(token, "submitting");
			const result = existing
				? { job: existing, pending: null }
				: await this.dependencies.submit(frozen.item.id, frozen.input);
			return {
				item: frozen.item,
				question: frozen.question,
				token,
				input: frozen.input,
				result,
			};
		})();
		frozen.pending = pending;
		void pending.catch(() => {
			frozen.pending = undefined;
		});
		return pending;
	}
}
