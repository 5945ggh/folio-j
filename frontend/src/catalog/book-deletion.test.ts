import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { refreshAfterBookDeletion } from "./book-deletion.ts";

test("删除隔离迟到正文并清除该书所有缓存，保留其他材料与学习积累", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	let finish: (value: string) => void = () => {};
	const late = new Promise<string>((resolve) => {
		finish = resolve;
	});
	const reading = client
		.fetchQuery({
			queryKey: ["materials", "deleted", "chapter", "chapter-1"],
			queryFn: () => late,
		})
		.catch(() => undefined);
	const catalog = client
		.fetchQuery({
			queryKey: ["catalog", "books", { page: 1 }],
			queryFn: () => late,
		})
		.catch(() => undefined);
	for (const key of [
		["materials", "deleted"],
		["materials", "deleted", "readings", "version-1"],
		["book-details", "deleted"],
		["book-statistics", "deleted", "version-1"],
		["materials", "other"],
		["segment", "saved"],
		["analysis", "saved"],
	])
		client.setQueryData(key, "saved");
	await refreshAfterBookDeletion(client, "deleted", "source-1");
	finish("late body");
	await Promise.all([reading, catalog]);
	assert.equal(
		client.getQueryData(["catalog", "books", { page: 1 }]),
		undefined,
	);
	assert.equal(
		client.getQueryCache().findAll({ queryKey: ["materials", "deleted"] })
			.length,
		0,
	);
	assert.equal(client.getQueryData(["book-details", "deleted"]), undefined);
	assert.equal(
		client.getQueryData(["book-statistics", "deleted", "version-1"]),
		undefined,
	);
	assert.equal(client.getQueryData(["materials", "other"]), "saved");
	assert.equal(client.getQueryData(["segment", "saved"]), "saved");
	assert.equal(client.getQueryData(["analysis", "saved"]), "saved");
	client.clear();
});

test("删除刷新目录、来源计数与详情", async () => {
	const client = new QueryClient();
	const keys = [
		["catalog", "sources", {}],
		["sources"],
		["source", "source-1"],
		["source-entry", "source-1"],
		["source-delete-impact", "source-1"],
	];
	for (const key of keys) client.setQueryData(key, "old");
	client.setQueryData(["source", "other"], "untouched");
	await refreshAfterBookDeletion(client, "deleted", "source-1");
	for (const key of keys)
		assert.equal(client.getQueryState(key)?.isInvalidated, true);
	assert.equal(client.getQueryState(["source", "other"])?.isInvalidated, false);
	client.clear();
});

test("重新订阅来源书籍目录时，等待刷新期间不会闪回已删书卡", async () => {
	for (const queryKey of [
		["catalog", "books", { source_id: "source-1", page_size: 3 }],
	]) {
		const client = new QueryClient();
		client.setQueryData(queryKey, ["deleted", "retained"]);
		await refreshAfterBookDeletion(client, "deleted", "source-1");
		let finish: (value: string[]) => void = () => {};
		const fresh = new Promise<string[]>((resolve) => {
			finish = resolve;
		});
		const observer = new QueryObserver(client, {
			queryKey,
			queryFn: () => fresh,
		});
		const rendered: (string[] | undefined)[] = [];
		const unsubscribe = observer.subscribe((result) =>
			rendered.push(result.data),
		);
		assert.equal(observer.getCurrentResult().data, undefined);
		finish(["retained"]);
		await observer.refetch();
		assert.deepEqual(observer.getCurrentResult().data, ["retained"]);
		assert.equal(
			rendered.some((items) => items?.includes("deleted")),
			false,
		);
		unsubscribe();
		client.clear();
	}
});

test("删除等待当前目录刷新完成，活动列表继续持有观察者并显示新结果", async () => {
	const client = new QueryClient();
	const queryKey = ["catalog", "books", { page: 1 }];
	client.setQueryData(queryKey, ["deleted", "retained"]);
	let finish: (value: string[]) => void = () => {};
	const fresh = new Promise<string[]>((resolve) => {
		finish = resolve;
	});
	const observer = new QueryObserver(client, {
		queryKey,
		queryFn: () => fresh,
		staleTime: Infinity,
	});
	const unsubscribe = observer.subscribe(() => {});
	const refresh = refreshAfterBookDeletion(client, "deleted", "source-1");
	finish(["retained"]);
	await refresh;
	assert.deepEqual(observer.getCurrentResult().data, ["retained"]);
	assert.equal(
		client.getQueryCache().find({ queryKey })?.getObserversCount(),
		1,
	);
	unsubscribe();
	client.clear();
});

test("一并删除取消无归属数据的首次详情读取，迟到响应不能重建缓存", async () => {
	const client = new QueryClient();
	const kinds = [
		"analysis",
		"analysis-impact",
		"chat-thread",
		"chat-messages",
		"chat-request",
		"chat-job",
		"translation-result",
		"translation-task",
	];
	const finishes: (() => void)[] = [];
	const pending = kinds.map((kind) =>
		client
			.fetchQuery({
				queryKey: [kind, "unknown-first-read"],
				queryFn: () =>
					new Promise<string>((resolve) => {
						finishes.push(() => resolve("late deleted content"));
					}),
			})
			.catch(() => undefined),
	);
	// There are deliberately no list or detail records to reveal ownership.
	for (const kind of kinds)
		client.setQueryData([kind, "known-other"], {
			id: "known-other",
			segment_id: "other",
			material_id: "other-book",
		});
	await refreshAfterBookDeletion(client, "book", "source", ["deleted-segment"]);
	for (const finish of finishes) finish();
	await Promise.all(pending);
	for (const kind of kinds) {
		assert.equal(client.getQueryState([kind, "unknown-first-read"]), undefined);
		assert.deepEqual(client.getQueryData([kind, "known-other"]), {
			id: "known-other",
			segment_id: "other",
			material_id: "other-book",
		});
	}
	client.clear();
});

test("批量清理按实际片段回执清除学习缓存，每个跨来源目录仅刷新一次", async () => {
	const client = new QueryClient();
	for (const id of ["first", "second"]) {
		client.setQueryData(["segment", id], { id });
		client.setQueryData(
			["analyses", id],
			[{ id: `analysis-${id}`, segment_id: id }],
		);
		client.setQueryData(["chat-threads", id], {
			pages: [
				{
					items: [
						{ id: `thread-${id}`, segment_id: id, active_job_id: `job-${id}` },
					],
				},
			],
		});
		client.setQueryData(["chat-job", `old-job-${id}`], {
			id: `old-job-${id}`,
			thread_id: `thread-${id}`,
		});
		for (const key of [
			["segments", id, "material-provenance"],
			["segment-edit-current", id],
			["segment-delete-impact", id],
			["segment-translations", id],
			["analysis", `analysis-${id}`, "revision"],
			["analysis-impact", `analysis-${id}`],
			["chat-thread", `thread-${id}`],
			["chat-messages", `thread-${id}`],
			["chat-request", `thread-${id}`, "request"],
			["chat-job", `job-${id}`],
		])
			client.setQueryData(key, "deleted");
	}
	const retainedKeys = [
		["materials", "same-source-other-book"],
		["segment", "from-other-book"],
		["segment", "manual"],
		["analysis", "retained-analysis", "revision"],
		["chat-messages", "retained-thread"],
		["translation-result", "other-translation"],
	];
	for (const key of retainedKeys) client.setQueryData(key, "retained");
	for (const kind of ["translation-result", "translation-task"])
		client.setQueryData([kind, "deleted-translation"], { material_id: "book" });
	const listKeys = [
		["catalog", "segments", "all-sources", {}],
		["catalog", "analyses", "all-sources", {}],
		["source-segments", "source"],
		["material-segment-matches", "source", {}],
	];
	const finishes: (() => void)[] = [];
	const unsubscriptions: (() => void)[] = [];
	const observers = listKeys.map((queryKey) => {
		const data = {
			items: [
				{ id: "first", segment_id: "first" },
				{ id: "second", segment_id: "second" },
				{ id: "from-other-book", segment_id: "from-other-book" },
				{ id: "manual", segment_id: "manual" },
			],
			total: 4,
			page: 2,
		};
		client.setQueryData(queryKey, data);
		let reads = 0;
		const observer = new QueryObserver(client, {
			queryKey,
			staleTime: Infinity,
			queryFn: () => {
				reads++;
				return new Promise<typeof data>((resolve) => {
					finishes.push(() =>
						resolve({ ...data, items: data.items.slice(2), total: 2 }),
					);
				});
			},
		});
		unsubscriptions.push(observer.subscribe(() => {}));
		return { observer, reads: () => reads };
	});
	const deletion = refreshAfterBookDeletion(client, "book", "source", [
		"first",
		"second",
	]);
	await new Promise((resolve) => setTimeout(resolve, 0));
	for (const { observer, reads } of observers) {
		assert.equal(reads(), 1);
		assert.deepEqual(
			observer.getCurrentResult().data?.items.map((item) => item.id),
			["from-other-book", "manual"],
		);
		assert.equal(observer.getCurrentResult().data?.page, 2);
	}
	for (const finish of finishes) finish();
	await deletion;
	for (const id of ["first", "second"]) {
		for (const kind of [
			"segment",
			"segments",
			"segment-edit-current",
			"segment-delete-impact",
			"segment-translations",
			"analyses",
			"chat-threads",
		])
			assert.equal(
				client.getQueryCache().findAll({ queryKey: [kind, id] }).length,
				0,
			);
		for (const [kind, target] of [
			["analysis", `analysis-${id}`],
			["analysis-impact", `analysis-${id}`],
			["chat-thread", `thread-${id}`],
			["chat-messages", `thread-${id}`],
			["chat-request", `thread-${id}`],
			["chat-job", `job-${id}`],
			["chat-job", `old-job-${id}`],
		])
			assert.equal(
				client.getQueryCache().findAll({ queryKey: [kind, target] }).length,
				0,
			);
	}
	for (const key of retainedKeys)
		assert.equal(client.getQueryData(key), "retained");
	for (const kind of ["translation-result", "translation-task"])
		assert.equal(client.getQueryData([kind, "deleted-translation"]), undefined);
	for (const unsubscribe of unsubscriptions) unsubscribe();
	client.clear();
});
