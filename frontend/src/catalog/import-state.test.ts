import assert from "node:assert/strict";
import { test } from "node:test";
import {
	environmentManager,
	MutationObserver,
	QueryClient,
	QueryObserver,
} from "@tanstack/react-query";
import { refreshAfterBookDeletion } from "./book-deletion.ts";
import {
	forgetCompletedImports,
	forgetDeletedMaterialImports,
	forgetSourceImports,
	type ImportInput,
	type ImportResult,
	type ImportTask,
	importKey,
	importOptions,
	importTask,
	visibleImportTasks,
} from "./import-state.ts";

const input: ImportInput = {
	sourceId: "source",
	file: new File(["epub"], "待处理.epub"),
};
const result: ImportResult = {
	material: {
		id: "book",
		source_id: "source",
		title: "本の題名",
		version_id: "version",
		source_sha256: "a".repeat(64),
		product_sha256: "b".repeat(64),
		contract_version: "1",
		created_at: "2026-10-25T00:00:00Z",
		warnings: [],
		chapters: [],
		reading_position: null,
		chapter_positions: [],
	},
	reused: false,
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("弹窗观察器卸载后仍完成导入并刷新目录和来源，预处理不发布假书籍", async () => {
	const client = new QueryClient();
	const work = deferred<ImportResult>();
	const keys = [
		["catalog", "books", { page: 1 }],
		["catalog", "books", { source_id: "source", page: 2 }],
		["materials", "source", "source"],
		["source", "source"],
		["sources"],
		["source-entry", "source"],
	];
	for (const key of keys) client.setQueryData(key, "before");
	const observer = new MutationObserver(
		client,
		importOptions(client, async (sourceId, file) => {
			assert.equal(sourceId, input.sourceId);
			assert.equal(file, input.file);
			return work.promise;
		}),
	);
	const unmount = observer.subscribe(() => {});
	const completion = observer.mutate(input);
	unmount();
	const mutation = client.getMutationCache().find({ mutationKey: importKey });
	assert.equal(mutation?.state.status, "pending");
	assert.equal(mutation?.state.data, undefined);
	assert.equal(
		client.getQueryData(["catalog", "books", { page: 1 }]),
		"before",
	);
	work.resolve(result);
	await completion;
	assert.equal(mutation?.state.status, "success");
	for (const key of keys)
		assert.equal(client.getQueryState(key)?.isInvalidated, true);
	client.clear();
});

test("失败不自动重复上传，重试使用原文件；并发请求独立完成", async () => {
	const client = new QueryClient();
	let attempts = 0;
	const first = deferred<ImportResult>();
	const options = importOptions(client, async (_sourceId, file) => {
		assert.equal(file, input.file);
		attempts++;
		if (attempts === 1) throw new Error("预处理失败");
		if (attempts === 2) return first.promise;
		return result;
	});
	const failed = client.getMutationCache().build(client, options);
	await assert.rejects(failed.execute(input), /预处理失败/);
	assert.equal(attempts, 1);
	assert.equal(failed.state.variables?.file, input.file);
	const retry = client.getMutationCache().build(client, options);
	const retryWork = retry.execute(input);
	const other = client.getMutationCache().build(client, options);
	await other.execute(input);
	assert.equal(other.state.status, "success");
	assert.equal(retry.state.status, "pending");
	first.resolve(result);
	await retryWork;
	assert.equal(retry.state.status, "success");
	client.clear();
});

test("只展示当前来源的导入，成功书卡与真实列表和复用结果去重", () => {
	const task: ImportTask = {
		id: 1,
		status: "success",
		input,
		data: result,
		error: null,
		invalidated: false,
	};
	const pending: ImportTask = {
		...task,
		id: 3,
		status: "pending",
		data: undefined,
	};
	const tasks = [task, { ...task, id: 2 }, pending];
	assert.deepEqual(visibleImportTasks(tasks, []), [task, pending]);
	assert.deepEqual(visibleImportTasks(tasks, ["book"]), [pending]);
	assert.deepEqual(visibleImportTasks(tasks, [], "different-source"), []);
	assert.deepEqual(visibleImportTasks([pending], [], "source"), [pending]);
});

test("已展示或已删除的成功任务被清除，不影响其他成功任务或进行中的导入", async () => {
	const client = new QueryClient();
	const options = importOptions(client, async () => result);
	const seen = client.getMutationCache().build(client, options);
	await seen.execute(input);
	const other = client.getMutationCache().build(
		client,
		importOptions(client, async () => ({
			...result,
			material: { ...result.material, id: "other" },
		})),
	);
	await other.execute(input);
	const work = deferred<ImportResult>();
	const pending = client.getMutationCache().build(
		client,
		importOptions(client, () => work.promise),
	);
	const completion = pending.execute(input);
	forgetCompletedImports(client, ["book"]);
	assert.deepEqual(client.getMutationCache().getAll(), [other, pending]);
	work.resolve(result);
	await completion;
	client.clear();
});

test("失败卡跨默认回收周期仍保留文件，等待用户重试或移除", async (t) => {
	const wasServer = environmentManager.isServer();
	environmentManager.setIsServer(() => false);
	t.after(() => environmentManager.setIsServer(() => wasServer));
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const client = new QueryClient();
	const observer = new MutationObserver(
		client,
		importOptions(client, async () => {
			throw new Error("预处理失败");
		}),
	);
	const unsubscribe = observer.subscribe(() => {});
	const work = observer.mutate(input);
	unsubscribe();
	await assert.rejects(work, /预处理失败/);
	t.mock.timers.tick(10 * 60 * 1000);
	const failed = client.getMutationCache().find({ mutationKey: importKey });
	assert.equal(failed?.state.status, "error");
	assert.equal(failed?.state.variables?.file, input.file);
	client.clear();
});

test("预处理完成即可阅读，慢目录核验不会继续阻塞书卡；删除清理不被迟到刷新恢复", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const refresh = deferred<string>();
	client.setQueryData(["sources"], "before");
	const query = new QueryObserver(client, {
		queryKey: ["sources"],
		queryFn: () => refresh.promise,
		staleTime: Infinity,
	});
	const unsubscribe = query.subscribe(() => {});
	const mutation = client.getMutationCache().build(
		client,
		importOptions(client, async () => result),
	);
	await mutation.execute(input);
	assert.equal(mutation.state.status, "success");
	const deletion = refreshAfterBookDeletion(client, "book", "source");
	assert.equal(client.getMutationCache().getAll().length, 0);
	refresh.resolve("after");
	await deletion;
	assert.equal(client.getMutationCache().getAll().length, 0);
	unsubscribe();
	client.clear();
});

test("材料或来源删除先于上传响应时，迟到成功不能恢复可点击卡", async () => {
	for (const scope of ["material", "source"]) {
		const client = new QueryClient();
		const response = deferred<ImportResult>();
		const mutation = client.getMutationCache().build(
			client,
			importOptions(client, () => response.promise),
		);
		const work = mutation.execute(input);
		if (scope === "material") forgetDeletedMaterialImports(client, "book");
		else forgetSourceImports(client, "source");
		response.resolve(result);
		await work;
		assert.equal(client.getMutationCache().getAll().length, 0);
		client.clear();
	}
});

test("来源删除清除成功、失败和待处理任务，保留其他来源", async () => {
	const client = new QueryClient();
	const options = importOptions(client, async () => result);
	await client.getMutationCache().build(client, options).execute(input);
	const other = client.getMutationCache().build(client, options);
	await other.execute({ ...input, sourceId: "other" });
	const failed = client.getMutationCache().build(
		client,
		importOptions(client, async () => {
			throw new Error("预处理失败");
		}),
	);
	await assert.rejects(failed.execute(input), /预处理失败/);
	const response = deferred<ImportResult>();
	const pending = client.getMutationCache().build(
		client,
		importOptions(client, () => response.promise),
	);
	const work = pending.execute(input);
	forgetSourceImports(client, "source");
	assert.deepEqual(client.getMutationCache().getAll(), [other]);
	response.resolve(result);
	await work;
	assert.deepEqual(client.getMutationCache().getAll(), [other]);
	client.clear();
});

test("导入成功回调与状态发布之间的删除也不会重现书卡，并能释放任务", async () => {
	const client = new QueryClient();
	client.setQueryData(["catalog", "books"], []);
	const unsubscribe = client.getQueryCache().subscribe((event) => {
		if (event.type === "updated" && event.action.type === "invalidate")
			queueMicrotask(() => forgetDeletedMaterialImports(client, "book"));
	});
	const mutation = client.getMutationCache().build(
		client,
		importOptions(client, async () => result),
	);
	await mutation.execute(input);
	const task = importTask(client, mutation);
	assert.equal(task.invalidated, true);
	assert.deepEqual(visibleImportTasks([task], []), []);
	forgetCompletedImports(client, [result.material.id]);
	assert.equal(client.getMutationCache().getAll().length, 0);
	unsubscribe();
	client.clear();
});
