import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
	refreshAfterSegmentDeletion,
	type SegmentDeleteImpact,
	sameSegmentDeleteImpact,
} from "./deletion.ts";

const impact: SegmentDeleteImpact = {
	segment_id: "segment",
	analysis_count: 1,
	thread_count: 2,
	message_count: 3,
	active_job_count: 0,
};
const segment = {
	id: "segment",
	source_id: "source",
	material_provenance: null,
};

test("confirmation covers every reported impact field, including analyses and identity", () => {
	assert.equal(sameSegmentDeleteImpact(impact, { ...impact }), true);
	for (const key of Object.keys(impact) as (keyof SegmentDeleteImpact)[]) {
		const value = impact[key];
		assert.equal(
			sameSegmentDeleteImpact(impact, {
				...impact,
				[key]: typeof value === "number" ? value + 1 : "other",
			}),
			false,
			key,
		);
	}
});

test("deletion retires late reads and related caches while retaining other learning content", async () => {
	const client = new QueryClient();
	client.setQueryData(["analyses", "segment"], {
		items: [{ id: "analysis", segment_id: "segment" }],
	});
	client.setQueryData(["chat-threads", "segment"], {
		pages: [
			{
				items: [{ id: "thread", segment_id: "segment", active_job_id: "job" }],
			},
		],
	});
	client.setQueryData(["chat-job", "old-job"], {
		id: "old-job",
		thread_id: "thread",
	});
	for (const key of [
		["segment", "segment"],
		["segments", "segment", "material-provenance"],
		["segment-delete-impact", "segment"],
		["segment-edit-current", "segment", 1],
		["segment-translations", "segment"],
		["analysis", "analysis", "revision"],
		["analysis-impact", "analysis"],
		["chat-thread", "thread"],
		["chat-messages", "thread"],
		["chat-request", "thread", "request"],
		["chat-job", "job"],
	])
		client.setQueryData(key, "deleted content");
	for (const key of [
		["segment", "other"],
		["analysis", "other", "current"],
		["chat-messages", "other"],
		["chat-job", "other"],
		["materials", "book", "chapter", "chapter"],
	])
		client.setQueryData(key, "retained");
	let finish = (_value: string) => {};
	const late = new Promise<string>((resolve) => {
		finish = resolve;
	});
	const pending = client
		.fetchQuery({
			queryKey: ["analysis", "analysis", "late-revision"],
			queryFn: () => late,
		})
		.catch(() => undefined);
	await refreshAfterSegmentDeletion(client, segment);
	finish("late deleted content");
	await pending;
	for (const kind of [
		"segment",
		"segments",
		"analyses",
		"chat-threads",
		"segment-translations",
	])
		assert.equal(client.getQueryData([kind, "segment"]), undefined);
	for (const key of [
		["analysis", "analysis", "revision"],
		["analysis", "analysis", "late-revision"],
		["analysis-impact", "analysis"],
		["chat-thread", "thread"],
		["chat-messages", "thread"],
		["chat-request", "thread", "request"],
		["chat-job", "job"],
		["chat-job", "old-job"],
	])
		assert.equal(client.getQueryData(key), undefined);
	assert.equal(client.getQueryData(["segment", "other"]), "retained");
	assert.equal(
		client.getQueryData(["analysis", "other", "current"]),
		"retained",
	);
	assert.equal(client.getQueryData(["chat-messages", "other"]), "retained");
	assert.equal(client.getQueryData(["chat-job", "other"]), "retained");
	assert.equal(
		client.getQueryData(["materials", "book", "chapter", "chapter"]),
		"retained",
	);
	client.clear();
});

test("deletion evicts inactive catalog and reader marks before another subscription", async () => {
	const client = new QueryClient();
	const keys = [
		["catalog", "segments", "source", {}],
		["catalog", "analyses", "source", {}],
		["catalog", "sources", {}],
		["source-segments", "source"],
		["source", "source"],
		["sources"],
		["source-delete-impact", "source"],
		["material-segment-matches", "source", {}],
		["material-chapter-segments", "book", "version", "chapter"],
		["book-details", "book"],
	];
	for (const key of keys) client.setQueryData(key, "old");
	await refreshAfterSegmentDeletion(client, {
		...segment,
		material_provenance: {
			material_id: "book",
			version_id: "version",
			contract_version: "1",
			ranges: [],
		},
	});
	for (const key of keys) assert.equal(client.getQueryData(key), undefined);
	client.clear();
});

test("deletion keeps active pagination, removes the row and waits for list refresh", async () => {
	const client = new QueryClient();
	const queryKey = ["catalog", "segments", "source", { page: 2 }];
	const data = {
		items: [{ id: "segment" }, { id: "other" }],
		total: 2,
		page: 2,
	};
	client.setQueryData(queryKey, data);
	let finish = (_value: typeof data) => {};
	const fresh = new Promise<typeof data>((resolve) => {
		finish = resolve;
	});
	const observer = new QueryObserver(client, {
		queryKey,
		queryFn: () => fresh,
		staleTime: Infinity,
	});
	const unsubscribe = observer.subscribe(() => {});
	let completed = false;
	const deletion = refreshAfterSegmentDeletion(client, segment).then(() => {
		completed = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(completed, false);
	assert.deepEqual(observer.getCurrentResult().data?.items, [{ id: "other" }]);
	assert.equal(observer.getCurrentResult().data?.page, 2);
	finish({ ...data, items: [{ id: "other" }], total: 1 });
	await deletion;
	assert.deepEqual(observer.getCurrentResult().data?.items, [{ id: "other" }]);
	assert.equal(observer.getCurrentResult().data?.total, 1);
	assert.equal(
		client.getQueryCache().find({ queryKey })?.getObserversCount(),
		1,
	);
	unsubscribe();
	client.clear();
});
