import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import type { MaterialProvenance } from "../materials/study-api.ts";
import type {
	TranslationRemoval,
	TranslationResult,
	TranslationTask,
} from "./api.ts";
import { TranslationPreferences } from "./preference.ts";
import { applyTranslationRemoval } from "./removal-cache.ts";

function result(offset = 0): TranslationResult {
	return {
		id: `result-${offset}`,
		task_id: `task-${offset}`,
		identity_sha256: `identity-${offset}`,
		material_id: "book",
		source_id: "source",
		chapter_id: "chapter",
		material_deleted: false,
		reader_deleted: false,
		adopted_segment_ids: ["saved"],
		material_provenance: {
			contract_version: "1",
			material_id: "book",
			version_id: "version",
			ranges: [
				{
					resource_id: "r",
					spine_index: 0,
					start: offset,
					end: offset + 3,
					exact: "猫だ。",
					text_sha256: "hash",
					prefix: "",
					suffix: "",
				},
			],
		},
		text: "猫だ。",
		translation: "猫。",
		context_before: "",
		context_after: "",
		parts: [],
		target_language: "中文",
		scheme_id: "scheme",
		scheme_name: "翻译",
		scheme_revision: 1,
		model_id: "model",
		provider_name: "provider",
		protocol: "chat_completions",
		prompt_version: "translation-v2",
		run_id: "run",
		created_at: "2026-10-30T00:00:00Z",
		temperature: null,
		reasoning_effort: null,
		max_output_tokens: null,
	};
}

test("removal clears every reader view while retaining adopted snapshots and other targets", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { gcTime: Infinity } },
	});
	const removed = result();
	const other = result(20);
	const old = { ...removed, id: "old", task_id: "old-task" };
	const task = (value: TranslationResult) => ({
		id: value.task_id,
		material_id: "book",
		status: "succeeded",
	});
	const history = {
		results: [removed, old, other],
		tasks: [task(removed), task(old), task(other)],
		next_offset: null,
	};
	const key = ["material-chapter-translations", "book", "version", "chapter"];
	client.setQueryData(["translations", "book", "identity-0", 0], history);
	client.setQueryData(["material-translation-activity", "book"], {
		tasks: history.tasks,
		resultIds: history.results.map((value) => value.id),
	});
	client.setQueryData(key, {
		pages: [{ items: [removed, other] }],
		pageParams: [null],
	});
	client.setQueryData(["translation-result", removed.id], removed);
	client.setQueryData(["translation-result", other.id], other);
	client.setQueryData(["translation-task", removed.task_id], task(removed));
	client.setQueryData(["segment-translations", "saved"], [removed]);
	const segment = {
		id: "saved",
		translation: "我另行编辑的译文。",
		revision: 4,
	};
	client.setQueryData(["segment", "saved"], segment);
	const receipt: TranslationRemoval = {
		identity_sha256: removed.identity_sha256,
		task_ids: [removed.task_id, old.task_id],
		result_ids: [removed.id, old.id],
		cancelled_task_ids: [],
	};
	try {
		await applyTranslationRemoval(client, "book", receipt);
		assert.deepEqual(
			client.getQueryData<typeof history>([
				"translations",
				"book",
				"identity-0",
				0,
			])?.results,
			undefined,
		);
		assert.deepEqual(
			client.getQueryData<{ resultIds: string[] }>([
				"material-translation-activity",
				"book",
			])?.resultIds,
			[other.id],
		);
		assert.deepEqual(
			client.getQueryData<{ pages: { items: TranslationResult[] }[] }>(key)
				?.pages[0]?.items,
			[other],
		);
		assert.equal(
			client.getQueryData<TranslationResult>(["translation-result", removed.id])
				?.reader_deleted,
			true,
		);
		assert.equal(client.getQueryData(["translation-result", other.id]), other);
		assert.equal(
			client.getQueryData(["translation-task", removed.task_id]),
			undefined,
		);
		assert.equal(
			client.getQueryData<TranslationResult[]>([
				"segment-translations",
				"saved",
			])?.[0]?.translation,
			removed.translation,
		);
		assert.equal(
			client.getQueryData<TranslationResult[]>([
				"segment-translations",
				"saved",
			])?.[0]?.reader_deleted,
			true,
		);
		assert.equal(client.getQueryData(["segment", "saved"]), segment);
	} finally {
		client.clear();
	}
});

test("a late detail read cannot overwrite the successful removal fact", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { gcTime: Infinity, retry: false } },
	});
	const saved = result();
	const key = ["translation-result", saved.id];
	client.setQueryData(key, saved);
	let release!: (value: TranslationResult) => void;
	const request = client
		.fetchQuery({
			queryKey: key,
			queryFn: () =>
				new Promise<TranslationResult>((resolve) => {
					release = resolve;
				}),
		})
		.catch(() => undefined);
	try {
		await applyTranslationRemoval(client, "book", {
			identity_sha256: saved.identity_sha256,
			task_ids: [saved.task_id],
			result_ids: [saved.id],
			cancelled_task_ids: [],
		});
		release(saved);
		await request;
		await Promise.resolve();
		assert.equal(
			client.getQueryData<TranslationResult>(key)?.reader_deleted,
			true,
		);
	} finally {
		client.clear();
	}
});

test("recent translation choices keep IDs across query eviction and respect exact occurrences", () => {
	const preferences = new TranslationPreferences();
	const saved = result();
	preferences.remember(saved);
	assert.equal(preferences.matching(saved.material_provenance), saved.id);
	assert.equal(preferences.matching(result(20).material_provenance), null);
	preferences.remember({ ...saved, id: "historical-choice" });
	assert.equal(
		preferences.matching(saved.material_provenance),
		"historical-choice",
	);
	preferences.remember({ ...saved, id: "deleted", reader_deleted: true });
	assert.equal(
		preferences.matching(saved.material_provenance),
		"historical-choice",
	);
	preferences.forget(saved.identity_sha256);
	assert.equal(preferences.matching(saved.material_provenance), null);
});

test("translation choices have one bounded recency order and normalize only outer whitespace", () => {
	const preferences = new TranslationPreferences();
	for (let index = 0; index < 33; index++)
		preferences.remember(result(index * 10));
	assert.equal(preferences.matching(result().material_provenance), null);
	assert.equal(
		preferences.matching(result(320).material_provenance),
		"result-320",
	);
	const saved = result(1000);
	preferences.remember(saved);
	const reference = structuredClone(
		saved.material_provenance,
	) as MaterialProvenance;
	const range = reference.ranges[0];
	assert.ok(range);
	Object.assign(range, { start: 999, end: 1004, exact: " 猫だ。 " });
	assert.equal(preferences.matching(reference), saved.id);
});

function taskFor(
	value: TranslationResult,
	status: TranslationTask["status"] = "succeeded",
): TranslationTask {
	return {
		id: value.task_id,
		material_id: value.material_id,
		source_id: value.source_id,
		material_provenance: value.material_provenance,
		text: value.text,
		context_before: "",
		context_after: "",
		status,
		result_id: status === "succeeded" ? value.id : null,
		run_id: value.run_id,
		error: null,
		created_at: value.created_at,
	};
}
function chapterItem(value: TranslationResult, count = 1) {
	return {
		identity_sha256: value.identity_sha256,
		material_provenance: value.material_provenance,
		result_id: value.id,
		result_count: count,
		excerpt: value.text,
		translation_excerpt: value.translation,
		target_language: value.target_language,
		created_at: value.created_at,
	};
}
test("late reads cannot restore removed history, chapter, detail or Segment facts while unrelated reads complete", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { gcTime: Infinity, retry: false } },
	});
	const deleted = result();
	const other = result(20);
	const active = { ...taskFor(deleted, "running"), id: "active" };
	const chapterKey = [
		"material-chapter-translations",
		"book",
		"version",
		"chapter",
	];
	const historyKey = ["translations", "book", deleted.identity_sha256, 0];
	const detailKey = ["translation-result", deleted.id];
	const segmentKey = ["segment-translations", "saved"];
	const taskKey = ["translation-task", active.id];
	const otherKey = ["translations", "book", other.identity_sha256, 0];
	const seeds: [readonly unknown[], unknown][] = [
		[
			chapterKey,
			{
				pages: [
					{
						items: [chapterItem(deleted, 2)],
						next_cursor: null,
						unavailable_count: 0,
					},
				],
				pageParams: [null],
			},
		],
		[
			historyKey,
			{
				results: [deleted],
				tasks: [taskFor(deleted), active],
				next_offset: null,
			},
		],
		[detailKey, deleted],
		[segmentKey, [deleted]],
		[taskKey, active],
		[
			otherKey,
			{ results: [other], tasks: [taskFor(other)], next_offset: null },
		],
	];
	const releases: (() => void)[] = [];
	const requests = seeds.map(([queryKey, value]) => {
		client.setQueryData(queryKey, value);
		return client
			.fetchQuery({
				queryKey,
				queryFn: () =>
					new Promise((resolve) => {
						releases.push(() => resolve(value));
					}),
			})
			.catch(() => undefined);
	});
	try {
		await applyTranslationRemoval(client, "book", {
			identity_sha256: deleted.identity_sha256,
			result_ids: [deleted.id],
			task_ids: [deleted.task_id, active.id],
			cancelled_task_ids: [active.id],
		});
		for (const release of releases) release();
		await Promise.all(requests);
		assert.equal(client.getQueryData(historyKey), undefined);
		assert.equal(
			client.getQueryData<TranslationResult>(detailKey)?.reader_deleted,
			true,
		);
		assert.equal(
			client.getQueryData<TranslationResult[]>(segmentKey)?.[0]?.reader_deleted,
			true,
		);
		assert.deepEqual(
			client.getQueryData<{ pages: { items: unknown[] }[] }>(chapterKey)
				?.pages[0]?.items,
			[],
		);
		assert.equal(client.getQueryData(taskKey), undefined);
		assert.equal(client.getQueryState(otherKey)?.status, "success");
		assert.equal(client.getQueryState(otherKey)?.isInvalidated, false);
	} finally {
		client.clear();
	}
});
