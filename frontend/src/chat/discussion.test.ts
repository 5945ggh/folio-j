import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import type { Job } from "./api.ts";
import {
	captureReadingPosition,
	DiscussionCoordinator,
	freshestJob,
	readingPositionForJob,
	savedArtifact,
	shouldOpenArtifact,
	visibleDraft,
} from "./discussion.ts";

const submitted = {
	action: "chat" as const,
	request_id: "same-request",
	expected_thread_revision: 1,
	expected_segment_revision: 1,
	question: "原问题",
	additional_instructions: "原补充",
	stream: true,
};

test("停止或审核后的新 Job 版本不会被旧轮询结果回退", () => {
	const stopping: { version: number; status: Job["status"] } = {
		version: 4,
		status: "stopping",
	};
	const oldRunning: { version: number; status: Job["status"] } = {
		version: 3,
		status: "running",
	};
	assert.equal(freshestJob(stopping, oldRunning), stopping);
	const review: { version: number; status: Job["status"] } = {
		version: 5,
		status: "waiting_review",
	};
	assert.equal(freshestJob(stopping, review), review);
});

test("成果身份来自持久 artifacts", () => {
	const terminal = {
		id: "job-1",
		status: "succeeded" as const,
		artifacts: [{ analysis_id: "analysis-1", revision_id: "revision-1" }],
	};
	assert.deepEqual(savedArtifact(terminal), {
		analysisId: "analysis-1",
		revisionId: "revision-1",
	});
});

test("迟到生成只有阅读位置未变时才自动打开成果", () => {
	const expected = { analysisId: "old", revisionId: "old-revision" };
	assert.equal(shouldOpenArtifact(expected, expected), true);
	assert.equal(
		shouldOpenArtifact(expected, {
			analysisId: "user-choice",
			revisionId: "current-revision",
		}),
		false,
	);
	assert.equal(
		shouldOpenArtifact(undefined, {
			analysisId: "user-choice",
			revisionId: "current-revision",
		}),
		true,
	);
});

test("同一 request_id 重试保留首次提交时的阅读位置", () => {
	const first = { analysisId: "first", revisionId: "first-revision" };
	const retry = { analysisId: "later", revisionId: "later-revision" };
	const positions = captureReadingPosition({}, "same-request", first);
	assert.deepEqual(
		captureReadingPosition(positions, "same-request", retry),
		positions,
	);
});

test("核实前终态也沿用 request_id 的首次阅读位置", () => {
	const expected = { analysisId: "before", revisionId: "before-revision" };
	const position = readingPositionForJob(
		{},
		{ "same-request": expected },
		{
			id: "accepted-later",
			request_id: "same-request",
		},
	);
	assert.equal(
		shouldOpenArtifact(position, {
			analysisId: "user-selected",
			revisionId: "user-revision",
		}),
		false,
	);
});

function job(version: number, status: Job["status"] = "running") {
	return {
		id: "job-1",
		version,
		status,
		artifacts: [{ analysis_id: "analysis-1", revision_id: "revision-1" }],
	} as Job;
}

test("讨论协调器在丢失受理响应后以同一 request_id 核实并刷新缓存", async () => {
	const client = new QueryClient();
	const invalidated: unknown[][] = [];
	const originalInvalidate = client.invalidateQueries.bind(client);
	client.invalidateQueries = async (filters) => {
		invalidated.push([...((filters?.queryKey ?? []) as readonly unknown[])]);
		return originalInvalidate(filters);
	};
	const requests: string[] = [];
	const coordinator = new DiscussionCoordinator(client, {
		submit: async () => {
			throw new TypeError("response lost");
		},
		findByRequest: async (_threadId, requestId) => {
			requests.push(requestId);
			return job(2, "interrupted");
		},
	});
	const first = await coordinator.submit("thread-1", submitted);
	assert.equal(first.pending?.input.request_id, "same-request");
	assert.ok(first.pending);
	const resolved = await coordinator.verify("thread-1", first.pending);
	assert.deepEqual(requests, ["same-request"]);
	assert.equal(resolved.job?.id, "job-1");
	assert.ok(resolved.job);
	let draft = { question: "核实期间继续编辑", additional: "原补充" };
	let notifications = 0;
	const accepted = coordinator.acceptSubmission(resolved.job, {
		threadId: "thread-1",
		segmentId: "segment-1",
		input: submitted,
		setRecentJobId: () => {},
		setPending: () => {},
		setDraft: (update) => {
			draft = update(draft);
		},
		setError: () => {},
		onJobAccepted: () => {},
		onGenerationAccepted: () => {},
	});
	coordinator.observeJob(accepted, {
		threadId: "thread-1",
		segmentId: "segment-1",
		onArtifact: () => {
			notifications += 1;
		},
	});
	assert.deepEqual(draft, {
		question: "核实期间继续编辑",
		additional: "原补充",
	});
	assert.equal(notifications, 1);
	assert.ok(invalidated.some((key) => key[0] === "chat-thread"));
	assert.ok(invalidated.some((key) => key[0] === "analyses"));
	assert.equal(client.getQueryData<Job>(["chat-job", "job-1"])?.version, 2);
});

test("生产受理入口以函数式草稿更新保留迟到响应期间的新编辑", () => {
	const client = new QueryClient();
	const coordinator = new DiscussionCoordinator(client, {
		submit: async () => job(1),
		findByRequest: async () => job(1),
	});
	let draft = { question: "提交后编辑", additional: "原补充" };
	let pending = { input: submitted, uncertain: true };
	let accepted = 0;
	coordinator.acceptSubmission(job(1, "queued"), {
		threadId: "thread-1",
		segmentId: "segment-1",
		input: submitted,
		setRecentJobId: () => {},
		setPending: (value) => {
			pending = value as typeof pending;
		},
		setDraft: (update) => {
			draft = update(draft);
		},
		setError: () => {},
		onJobAccepted: () => {
			accepted += 1;
		},
		onGenerationAccepted: () => {},
	});
	assert.deepEqual(draft, { question: "提交后编辑", additional: "原补充" });
	assert.equal(pending, null);
	assert.equal(accepted, 1);
});

test("生产 Job 入口只对合并后的终态刷新并通知一次", () => {
	const client = new QueryClient();
	const coordinator = new DiscussionCoordinator(client, {
		submit: async () => job(1),
		findByRequest: async () => job(1),
	});
	let artifacts = 0;
	const callbacks = {
		threadId: "thread-1",
		segmentId: "segment-1",
		onArtifact: () => {
			artifacts += 1;
		},
	};
	coordinator.observeJob(job(4, "stopping"), callbacks);
	coordinator.observeJob(job(3, "running"), callbacks);
	assert.equal(
		client.getQueryData<Job>(["chat-job", "job-1"])?.status,
		"stopping",
	);
	assert.equal(
		coordinator.observeJob(job(5, "interrupted"), callbacks).notify,
		true,
	);
	assert.equal(
		coordinator.observeJob(job(5, "interrupted"), callbacks).notify,
		false,
	);
	assert.equal(
		coordinator.observeJob(job(3, "running"), callbacks).notify,
		false,
	);
	assert.equal(artifacts, 1);
});

test("重复观察同版本 Job 不重复写入 QueryClient 缓存", () => {
	const client = new QueryClient();
	const coordinator = new DiscussionCoordinator(client, {
		submit: async () => job(1),
		findByRequest: async () => job(1),
	});
	let updates = 0;
	const unsubscribe = client.getQueryCache().subscribe((event) => {
		if (event.type === "updated" && event.query.queryKey[0] === "chat-job")
			updates += 1;
	});
	const callbacks = {
		threadId: "thread-1",
		segmentId: "segment-1",
		onArtifact: () => {},
	};
	coordinator.observeJob(job(1, "running"), callbacks);
	coordinator.observeJob(job(1, "running"), callbacks);
	unsubscribe();
	assert.equal(updates, 1);
});

test("旧补充要求合并为可见问题，保留全文且再次转换不重复", () => {
	const legacy = { question: "原问题", additional: "  保留例句\n只讲语气  " };
	const restored = visibleDraft(legacy);
	assert.deepEqual(restored, {
		question: "原问题\n\n补充要求：\n  保留例句\n只讲语气  ",
		additional: "",
	});
	assert.equal(visibleDraft(restored), restored);
	assert.deepEqual(visibleDraft({ question: "", additional: "保留例句" }), {
		question: "补充要求：\n保留例句",
		additional: "",
	});
});
