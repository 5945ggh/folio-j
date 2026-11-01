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
