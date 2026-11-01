import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { ReaderImageCache } from "./reader-image-cache.ts";
import {
	isReaderResourceQuery,
	ReaderResourceBudget,
	readerResourceBytes,
	readerResourceCache,
} from "./reader-resource-cache.ts";

const settle = () => Promise.resolve();
const client = () =>
	new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	});

test("one byte/item LRU evicts cold resources across kinds and preserves recent use", () => {
	const budget = new ReaderResourceBudget({ maxBytes: 1000, maxItems: 2 });
	const chapter = {},
		image = {},
		readings = {};
	const evicted: string[] = [];
	budget.retain(chapter, 100, () => evicted.push("chapter"));
	budget.retain(image, 100, () => evicted.push("image"));
	budget.touch(chapter);
	budget.retain(readings, 100, () => evicted.push("readings"));
	assert.deepEqual(evicted, ["image"]);
	assert.equal(budget.diagnostics.items, 2);
	budget.release(chapter);
	budget.release(readings);
	assert.equal(budget.diagnostics.bytes, 0);
});

test("oversized pinned work evicts every cold entry and is reclaimed when released", () => {
	const budget = new ReaderResourceBudget({ maxBytes: 100, maxItems: 2 });
	const cold = {},
		active = {};
	let pinned = true;
	const evicted: string[] = [];
	budget.retain(cold, 10, () => evicted.push("cold"));
	budget.retain(
		active,
		200,
		() => evicted.push("active"),
		() => pinned,
	);
	assert.deepEqual(evicted, ["cold"]);
	assert.ok(budget.diagnostics.bytes > budget.maxBytes);
	assert.equal(budget.diagnostics.pinnedItems, 1);
	pinned = false;
	budget.trim();
	assert.deepEqual(evicted, ["cold", "active"]);
	assert.equal(budget.diagnostics.bytes, 0);
});

test("a cold oversized result is declined without evicting useful retained data", () => {
	const budget = new ReaderResourceBudget({ maxBytes: 200 });
	const evicted: string[] = [];
	budget.retain({}, 10, () => evicted.push("useful"));
	assert.equal(
		budget.retain({}, 500, () => evicted.push("large")),
		false,
	);
	assert.deepEqual(evicted, ["large"]);
	assert.equal(budget.diagnostics.items, 1);
});

test("reader query families include chapters, readings, translations, gallery, search and records", () => {
	for (const key of [
		["materials", "book", "chapter", "chapter"],
		["materials", "book", "readings", "v", "chapter", "generation"],
		["translation-result", "result"],
		["translation-task", "task"],
		["translation-identity", { material_id: "book", ranges: [] }],
		["translations", "book", "identity", 0],
		["materials", "book", "v", "illustrations", 0],
		["materials", "book", "v", "reader-search", "text"],
		["material-chapter-segments", "book", "v", "chapter"],
		["material-chapter-translations", "book", "v", "chapter"],
		["material-translation-activity", "book"],
		["materials", "book", "v", "position-bookmarks"],
	])
		assert.equal(isReaderResourceQuery(key), true);
	for (const key of [["catalog"], ["settings"], ["segments", "id"]])
		assert.equal(isReaderResourceQuery(key), false);
});

test("query adapter shares one owner per client, stores original data, and evicts oldest cold family", async () => {
	const queries = client();
	const budget = readerResourceCache(queries, { maxBytes: 2000, maxItems: 2 });
	assert.equal(readerResourceCache(queries), budget);
	const chapter = ["materials", "book", "chapter", "one"];
	const readings = ["materials", "book", "readings", "one"];
	const translation = ["translation-result", "result"];
	const data = { text: "unchanged" };
	queries.setQueryData(chapter, data);
	queries.setQueryData(readings, { tokens: [] });
	queries.setQueryData(["settings"], { text: "unrelated" });
	await settle();
	const observer = new QueryObserver(queries, {
		queryKey: chapter,
		enabled: false,
	});
	const unsubscribe = observer.subscribe(() => {});
	await settle();
	unsubscribe();
	await settle();
	queries.setQueryData(translation, { translation: "saved" });
	await settle();
	assert.equal(queries.getQueryData(readings), undefined);
	assert.equal(queries.getQueryData(chapter), data);
	assert.deepEqual(queries.getQueryData(["settings"]), { text: "unrelated" });
	assert.equal(budget.diagnostics.items, 2);
	queries.clear();
	assert.equal(budget.diagnostics.bytes, 0);
});

test("disabled retained-reader observers pin data; leaving releases oversized queries", async () => {
	const queries = client();
	const budget = readerResourceCache(queries, { maxBytes: 300, maxItems: 1 });
	const chapter = ["materials", "book", "chapter", "one"];
	const observer = new QueryObserver(queries, {
		queryKey: chapter,
		enabled: false,
	});
	const unsubscribe = observer.subscribe(() => {});
	queries.setQueryData(chapter, { text: "x".repeat(1000) });
	queries.setQueryData(["translation-result", "cold"], { translation: "cold" });
	await settle();
	assert.ok(queries.getQueryData(chapter));
	assert.equal(queries.getQueryData(["translation-result", "cold"]), undefined);
	assert.equal(budget.diagnostics.pinnedItems, 1);
	assert.ok(budget.diagnostics.bytes > budget.maxBytes);
	unsubscribe();
	await settle();
	assert.equal(queries.getQueryData(chapter), undefined);
	assert.equal(budget.diagnostics.bytes, 0);
	queries.clear();
});

test("large fetch responses still resolve without being retained by an unobserved query", async () => {
	const queries = client();
	const budget = readerResourceCache(queries, { maxBytes: 300 });
	const data = { translation: "x".repeat(1000) };
	const key = ["translation-result", "large"];
	assert.equal(
		await queries.fetchQuery({ queryKey: key, queryFn: async () => data }),
		data,
	);
	await settle();
	assert.equal(queries.getQueryData(key), undefined);
	assert.equal(budget.diagnostics.bytes, 0);
	queries.clear();
});

test("query payloads and blobs compete under the same budget across reader instances", async () => {
	const queries = client();
	const budget = readerResourceCache(queries, { maxBytes: 1200 });
	const images = new ReaderImageCache(budget);
	const anotherReader = new ReaderImageCache(budget);
	const key = ["materials", "book", "chapter", "one"];
	queries.setQueryData(key, { text: "x".repeat(350) });
	await settle();
	const source = `data:image/png;base64,${btoa("b".repeat(200))}`;
	const signal = new AbortController().signal;
	const first = await images.get(source, signal);
	assert.equal(queries.getQueryData(key), undefined);
	assert.ok(budget.diagnostics.bytes <= budget.maxBytes);
	const other = `data:image/png;base64,${btoa("c".repeat(200))}`;
	await anotherReader.get(other, signal);
	assert.notEqual(await images.get(source, signal), first);
	images.close();
	anotherReader.close();
	queries.clear();
	assert.equal(budget.diagnostics.bytes, 0);
});

test("data URI keys are charged along with blobs, and oversized image data is not cached", async () => {
	const budget = new ReaderResourceBudget({ maxBytes: 500 });
	const images = new ReaderImageCache(budget);
	const source = `data:image/png;base64,${btoa("x".repeat(200))}`;
	assert.ok(source.length * 2 > budget.maxBytes);
	const signal = new AbortController().signal;
	const first = await images.get(source, signal);
	assert.equal(first.size, 200);
	assert.notEqual(await images.get(source, signal), first);
	images.rememberSource("/occurrence", source);
	assert.equal(budget.diagnostics.bytes, 0);
	images.close();
});

test("illustration metadata, source aliases and blobs also share the item limit", async () => {
	const budget = new ReaderResourceBudget({ maxBytes: 10000, maxItems: 2 });
	const images = new ReaderImageCache(budget);
	images.remember(
		[0, 1].map((ordinal) => ({
			ordinal,
			chapter_id: "chapter",
			chapter_title: "Chapter",
			part_index: 0,
			spine_index: 0,
			resource_id: "resource",
			image_id: ordinal,
			alt: "image",
			content_url: `/image/${ordinal}`,
		})),
		2,
	);
	images.rememberSource("/image/1", "data:image/png;base64,aGVsbG8=");
	assert.equal(images.item(0), undefined);
	assert.ok(images.item(1));
	await images.get("/image/1", new AbortController().signal);
	assert.equal(images.item(1), undefined);
	assert.equal(budget.diagnostics.items, 2);
	images.close();
	assert.equal(budget.diagnostics.bytes, 0);
});

test("visible image leases pin oversized Blob and data URI together, then reclaim on revoke", async () => {
	const queries = client();
	const budget = readerResourceCache(queries, { maxBytes: 500 });
	const images = new ReaderImageCache(budget);
	const source = `data:image/png;base64,${btoa("x".repeat(200))}`;
	queries.setQueryData(["translation-result", "cold"], {
		translation: "saved",
	});
	await settle();
	const lease = await images.acquire(source, new AbortController().signal);
	assert.equal(budget.diagnostics.pinnedItems, 1);
	assert.ok(budget.diagnostics.bytes >= source.length * 2 + lease.blob.size);
	assert.equal(queries.getQueryData(["translation-result", "cold"]), undefined);
	lease.release();
	lease.release();
	assert.equal(budget.diagnostics.bytes, 0);
	images.close();
	queries.clear();
});

test("associating a displayed image preserves its pin and releasing one viewer keeps another pinned", async () => {
	const budget = new ReaderResourceBudget({ maxBytes: 1000 });
	const images = new ReaderImageCache(budget);
	const original = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response(new Blob(["hello"], { type: "image/png" }));
	try {
		const signal = new AbortController().signal;
		const first = await images.acquire("/image", signal);
		images.rememberSource("/image", "data:image/png;base64,aGVsbG8=");
		assert.equal(budget.diagnostics.pinnedItems, 1);
		const second = await images.acquire("/image", signal);
		assert.equal(second.blob, first.blob);
		assert.equal(budget.diagnostics.pinnedItems, 1);
		first.release();
		assert.equal(budget.diagnostics.pinnedItems, 1);
		second.release();
		assert.equal(budget.diagnostics.pinnedItems, 0);
	} finally {
		globalThis.fetch = original;
		images.close();
	}
	assert.equal(budget.diagnostics.bytes, 0);
});

test("accounting handles shared object references and cycles without serializing a second payload", () => {
	const common = { text: "same" };
	const value: {
		first: typeof common;
		second: typeof common;
		cycle?: unknown;
	} = { first: common, second: common };
	value.cycle = value;
	assert.ok(readerResourceBytes(value) > 0);
	assert.ok(
		readerResourceBytes({ first: common, second: { ...common } }) >
			readerResourceBytes({ first: common, second: common }),
	);
});

test("failed queries without data share the item limit instead of waiting for time GC", async () => {
	const queries = client();
	const budget = readerResourceCache(queries, {
		maxBytes: 100000,
		maxItems: 2,
	});
	for (const id of ["first", "second", "third"]) {
		await assert.rejects(
			queries.fetchQuery({
				queryKey: ["translation-result", id],
				queryFn: async () => {
					throw new Error("Unavailable");
				},
			}),
		);
	}
	await settle();
	assert.equal(budget.diagnostics.items, 2);
	assert.equal(queries.getQueryCache().getAll().length, 2);
	assert.equal(
		queries.getQueryState(["translation-result", "first"]),
		undefined,
	);
	assert.equal(
		queries.getQueryState(["translation-result", "third"])?.status,
		"error",
	);
	queries.clear();
});

test("key-only identity queries and non-enumerable error diagnostics obey the byte limit", async () => {
	const queries = client();
	const budget = readerResourceCache(queries, { maxBytes: 800 });
	queries.getQueryCache().build(queries, {
		queryKey: ["translation-identity", { exact: "x".repeat(1000) }],
	});
	await settle();
	assert.equal(queries.getQueryCache().getAll().length, 0);
	for (const field of ["message", "stack", "cause"] as const) {
		const error = new Error("small");
		error.stack = "";
		Object.defineProperty(error, field, {
			value: "x".repeat(1000),
			configurable: true,
		});
		await assert.rejects(
			queries.fetchQuery({
				queryKey: ["translation-result", field],
				queryFn: async () => {
					throw error;
				},
			}),
		);
		await settle();
		assert.equal(
			queries.getQueryState(["translation-result", field]),
			undefined,
		);
	}
	assert.equal(budget.diagnostics.bytes, 0);
	queries.clear();
});

test("changing error facts remeasures a pinned failed query even when its data stays undefined", async () => {
	const queries = client();
	const budget = readerResourceCache(queries, { maxBytes: 800 });
	const key = ["translation-result", "failed"];
	const observer = new QueryObserver(queries, {
		queryKey: key,
		enabled: false,
	});
	const unsubscribe = observer.subscribe(() => {});
	const query = queries.getQueryCache().find({ queryKey: key });
	assert.ok(query);
	const small = new Error("small");
	small.stack = "";
	query.setState({ status: "error", error: small });
	await settle();
	const before = budget.diagnostics.bytes;
	const large = new Error("large", { cause: { response: "x".repeat(1000) } });
	large.stack = "";
	query.setState({ status: "error", error: large });
	await settle();
	assert.ok(budget.diagnostics.bytes > before);
	assert.ok(budget.diagnostics.bytes > budget.maxBytes);
	assert.equal(budget.diagnostics.pinnedItems, 1);
	assert.equal(queries.getQueryState(key)?.error, large);
	unsubscribe();
	await settle();
	assert.equal(queries.getQueryState(key), undefined);
	assert.equal(budget.diagnostics.bytes, 0);
	queries.clear();
});

test("nested and cyclic Error causes include diagnostics without traversing forever", () => {
	const error = new Error("outer", { cause: new Error("nested message") });
	error.stack = "";
	assert.ok(
		readerResourceBytes(error) >=
			"outer".length * 2 + "nested message".length * 2,
	);
	Object.defineProperty(error, "cause", { value: error });
	assert.ok(Number.isFinite(readerResourceBytes(error)));
	assert.ok(
		readerResourceBytes(
			new AggregateError([new Error("x".repeat(1000))], "aggregate"),
		) > 2000,
	);
});
