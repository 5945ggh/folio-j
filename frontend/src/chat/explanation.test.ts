import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import type { Job, JobInput, Thread } from "./api.ts";
import { DiscussionCoordinator } from "./discussion.ts";
import { ExplanationRequests } from "./explanation.ts";

const thread = (id: string) => ({ id, revision: 3 }) as Thread;
const job = { id: "job", status: "queued", version: 1 } as Job;

test("每个点击独立完成普通提交，同意图不重复，不依赖可见线程", async () => {
	const calls: Array<[string, string]> = [];
	const submissions: Array<[string, JobInput]> = [];
	const releases: Array<() => void> = [];
	const requests = new ExplanationRequests({
		findByRequest: async () => {
			throw { status: 404 };
		},
		readPrompt: async () => ({
			question: "后端预定问题：为当前片段创建并保存一份独立讲解。",
		}),
		createThread: (requestId, modelId) => {
			calls.push([requestId, modelId]);
			return new Promise<Thread>((resolve) =>
				releases.push(() => resolve(thread(requestId))),
			);
		},
		submit: async (id, input) => {
			submissions.push([id, input]);
			return { job, pending: null };
		},
	});
	const first = requests.start("click-1", "selected-model", 7);
	assert.equal(requests.start("click-1", "changed-model", 8), first);
	const second = requests.start("click-2", "selected-model", 9);
	await Promise.resolve();
	releases[1]?.();
	releases[0]?.();
	await Promise.all([first, second]);
	assert.deepEqual(calls, [
		["click-1", "selected-model"],
		["click-2", "selected-model"],
	]);
	assert.deepEqual(submissions.map(([id]) => id).sort(), [
		"click-1",
		"click-2",
	]);
	const firstInput = submissions.find(([id]) => id === "click-1")?.[1];
	assert.equal(
		firstInput?.question,
		"后端预定问题：为当前片段创建并保存一份独立讲解。",
	);
	assert.equal(firstInput?.expected_segment_revision, 7);
	assert.equal(firstInput?.expected_thread_revision, 3);
	assert.equal(Object.hasOwn(firstInput ?? {}, "action"), false);
});

test("创建响应丢失后保留首次问题、模型、片段版本和request_id", async () => {
	let prompt = "首次完整问题";
	let reads = 0;
	const calls: Array<[string, string]> = [];
	const requests = new ExplanationRequests({
		findByRequest: async () => {
			throw { status: 404 };
		},
		readPrompt: async () => {
			reads++;
			return { question: prompt };
		},
		createThread: async (requestId, modelId) => {
			calls.push([requestId, modelId]);
			if (calls.length === 1) throw new TypeError("response lost");
			return thread("persisted-thread");
		},
		submit: async () => ({ job, pending: null }),
	});
	await assert.rejects(requests.start("same-click", "first-model", 7));
	prompt = "后端问题已经变化";
	const restored = await requests.start("same-click", "later-model", 8);
	assert.equal(restored.question, "首次完整问题");
	assert.equal(restored.input.expected_segment_revision, 7);
	assert.equal(reads, 1);
	assert.deepEqual(calls, [
		["same-click", "first-model"],
		["same-click", "first-model"],
	]);
});

test("普通POST响应不确定后仅保留原请求等待核实，不自动再次提交", async () => {
	let posts = 0;
	const client = new QueryClient();
	const coordinator = new DiscussionCoordinator(client, {
		submit: async () => {
			posts++;
			throw new TypeError("response lost");
		},
		findByRequest: async (_id, requestId) => {
			assert.equal(requestId, "same-click");
			return job;
		},
	});
	const requests = new ExplanationRequests({
		findByRequest: async () => {
			throw { status: 404 };
		},
		readPrompt: async () => ({ question: "完整冻结的问题" }),
		createThread: async () => thread("new-thread"),
		submit: (id, input) => coordinator.submit(id, input),
	});
	const result = await requests.start("same-click", "model", 7);
	assert.ok(result.result.pending);
	assert.equal(result.result.pending.input, result.input);
	assert.equal(
		await requests.start("same-click", "different-model", 8),
		result,
	);
	await coordinator.verify("new-thread", result.result.pending);
	assert.equal(posts, 1);
	client.clear();
});

test("同token组件重建从持久Job核实，恢复原问题且不再POST", async () => {
	const client = new QueryClient();
	const persisted = new Map<string, Job>();
	let posts = 0;
	let reads = 0;
	let prompt = "首次后端问题";
	const coordinator = new DiscussionCoordinator(client, {
		submit: async (_id, input) => {
			posts++;
			const saved = {
				...job,
				request_id: input.request_id,
				question: input.question,
			};
			persisted.set(input.request_id, saved);
			return saved;
		},
		findByRequest: async (_id, requestId) => {
			reads++;
			const saved = persisted.get(requestId);
			if (!saved) throw { status: 404 };
			return saved;
		},
	});
	const dependencies = {
		readPrompt: async () => ({ question: prompt }),
		createThread: async () => thread("same-persisted-thread"),
		submit: (id: string, input: JobInput) => coordinator.submit(id, input),
		findByRequest: async (id: string, requestId: string) => {
			const result = await coordinator.verify(id, {
				input: { request_id: requestId } as JobInput,
				uncertain: true,
			});
			return result.job;
		},
	};
	await new ExplanationRequests(dependencies).start("same-token", "model", 7);
	prompt = "稍后升级的新问题";
	const restored = await new ExplanationRequests(dependencies).start(
		"same-token",
		"model",
		8,
	);
	assert.equal(posts, 1);
	assert.equal(reads, 2);
	assert.equal(restored.question, "首次后端问题");
	assert.equal(restored.result.job?.request_id, "same-token");
	client.clear();
});

test("较早创建响应丢失不影响较晚成功，原token重试沿用冻结依据且只提交一次", async () => {
	const created = new Map<string, Thread>();
	const creations: Array<[string, string]> = [];
	const submissions: Array<[string, JobInput]> = [];
	const failures: Array<() => void> = [];
	let prompt = "首次创建保存问题";
	let reads = 0;
	const requests = new ExplanationRequests({
		readPrompt: async () => {
			reads++;
			return { question: prompt };
		},
		createThread: async (token, modelId) => {
			creations.push([token, modelId]);
			const existing = created.get(token);
			if (existing) return existing;
			const item = thread(`thread-${token}`);
			created.set(token, item);
			if (token === "A")
				await new Promise<void>((_resolve, reject) =>
					failures.push(() => reject(new TypeError("创建响应丢失"))),
				);
			return item;
		},
		findByRequest: async () => {
			throw { status: 404 };
		},
		submit: async (id, input) => {
			submissions.push([id, input]);
			return { job, pending: null };
		},
	});
	const first = requests.start("A", "model-A", 7);
	const rejected = assert.rejects(first, /创建响应丢失/);
	await requests.start("B", "model-B", 8);
	assert.deepEqual(
		submissions.map(([id]) => id),
		["thread-B"],
	);
	failures[0]?.();
	await rejected;
	prompt = "稍后变更的问题";
	const restored = await requests.start("A", "changed-model", 9);
	assert.equal(restored.item, created.get("A"));
	assert.equal(restored.question, "首次创建保存问题");
	assert.equal(restored.input.expected_segment_revision, 7);
	assert.equal(restored.input.request_id, "A");
	assert.equal(reads, 2);
	assert.equal(created.size, 2);
	assert.deepEqual(creations, [
		["A", "model-A"],
		["B", "model-B"],
		["A", "model-A"],
	]);
	assert.deepEqual(
		submissions.map(([id]) => id),
		["thread-B", "thread-A"],
	);
	await requests.start("A", "changed-again", 10);
	assert.equal(submissions.length, 2);
});
