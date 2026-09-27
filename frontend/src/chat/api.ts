import { api } from "../api/client";
import type { components } from "../api/schema";
import { requireData } from "../content";

export type Thread = components["schemas"]["ThreadResponse"];
export type Message = components["schemas"]["MessageResponse"];
export type Job = components["schemas"]["JobResponse"];
export type JobInput = components["schemas"]["JobCreate"];
export type JobDecision = components["schemas"]["JobDecision"];

export const chatKeys = {
	threads: (segmentId: string) => ["chat-threads", segmentId] as const,
	thread: (threadId: string) => ["chat-thread", threadId] as const,
	messages: (threadId: string) => ["chat-messages", threadId] as const,
	job: (jobId: string) => ["chat-job", jobId] as const,
	request: (threadId: string, requestId: string) =>
		["chat-request", threadId, requestId] as const,
};

export async function listThreads(segmentId: string, cursor?: string) {
	const { data, error, response } = await api.GET(
		"/api/segments/{segment_id}/threads",
		{
			params: { path: { segment_id: segmentId }, query: { cursor, limit: 20 } },
		},
	);
	return requireData(data, error, response.status);
}

export async function createThread(
	segmentId: string,
	requestId: string,
	modelId?: string,
) {
	const { data, error, response } = await api.POST(
		"/api/segments/{segment_id}/threads",
		{
			params: { path: { segment_id: segmentId } },
			body: {
				request_id: requestId,
				...(modelId ? { model_id: modelId } : {}),
			},
		},
	);
	return requireData(data, error, response.status);
}

export async function getThread(threadId: string) {
	const { data, error, response } = await api.GET("/api/threads/{thread_id}", {
		params: { path: { thread_id: threadId } },
	});
	return requireData(data, error, response.status);
}

export async function patchThread(
	threadId: string,
	input: {
		expected_revision: number;
		model_id?: string | null;
		permission_mode?: Thread["permission_mode"];
	},
) {
	const { data, error, response } = await api.PATCH(
		"/api/threads/{thread_id}",
		{
			params: { path: { thread_id: threadId } },
			body: input,
		},
	);
	return requireData(data, error, response.status);
}

export async function listMessages(threadId: string, afterOrdinal: number) {
	const { data, error, response } = await api.GET(
		"/api/threads/{thread_id}/messages",
		{
			params: {
				path: { thread_id: threadId },
				query: { after_ordinal: afterOrdinal, limit: 50 },
			},
		},
	);
	return requireData(data, error, response.status);
}

export async function submitJob(threadId: string, input: JobInput) {
	const { data, error, response } = await api.POST(
		"/api/threads/{thread_id}/jobs",
		{ params: { path: { thread_id: threadId } }, body: input },
	);
	return requireData(data, error, response.status);
}

export async function getJobByRequest(threadId: string, requestId: string) {
	const { data, error, response } = await api.GET(
		"/api/threads/{thread_id}/jobs/by-request/{request_id}",
		{ params: { path: { thread_id: threadId, request_id: requestId } } },
	);
	return requireData(data, error, response.status);
}

export async function getJob(jobId: string) {
	const { data, error, response } = await api.GET("/api/jobs/{job_id}", {
		params: { path: { job_id: jobId } },
	});
	return requireData(data, error, response.status);
}

export async function stopJob(jobId: string) {
	const { data, error, response } = await api.POST("/api/jobs/{job_id}/stop", {
		params: { path: { job_id: jobId } },
	});
	return requireData(data, error, response.status);
}

export async function decideJob(jobId: string, input: JobDecision) {
	const { data, error, response } = await api.POST(
		"/api/jobs/{job_id}/decision",
		{ params: { path: { job_id: jobId } }, body: input },
	);
	return requireData(data, error, response.status);
}
