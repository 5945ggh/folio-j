import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import type { MaterialProvenance } from "../materials/study-api.ts";
import type {
	TranslationRemoval,
	TranslationResult,
	TranslationResultRemoval,
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
function singleReceipt(
	deleted: TranslationResult,
	remaining: TranslationResult | null,
	count = remaining ? 1 : 0,
): TranslationResultRemoval {
	return {
		identity_sha256: deleted.identity_sha256,
		task_ids: [deleted.task_id],
		result_ids: [deleted.id],
		cancelled_task_ids: [],
		remaining_result: remaining,
		remaining_result_count: count,
	};
}

test("single-result removal replaces chapter latest and count, retains active work, snapshots and other targets", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { gcTime: Infinity } },
	});
	const deleted = result();
	const latest = {
		...deleted,
		id: "latest-remaining",
		task_id: "latest-task",
		translation: `${"😀".repeat(159)}猫末尾`,
		target_language: "English",
		created_at: "2026-10-29T00:00:00Z",
	};
	const older = { ...deleted, id: "older", task_id: "older-task" };
	const active = { ...taskFor(deleted, "running"), id: "active-task" };
	const other = result(20);
	const otherTask = taskFor(other);
	const chapterKey = [
		"material-chapter-translations",
		"book",
		"version",
		"chapter",
	];
	const firstKey = ["translations", "book", deleted.identity_sha256, 0];
	const nextKey = ["translations", "book", deleted.identity_sha256, 15];
	const otherKey = ["translations", "book", other.identity_sha256, 0];
	const otherHistory = {
		results: [other],
		tasks: [otherTask],
		next_offset: null,
	};
	const activity = {
		tasks: [taskFor(deleted), taskFor(latest), active, otherTask],
		resultIds: [deleted.id, latest.id, older.id, other.id],
	};
	client.setQueryData(firstKey, {
		results: [deleted, latest],
		tasks: activity.tasks,
		next_offset: 15,
	});
	client.setQueryData(nextKey, {
		results: [older],
		tasks: [taskFor(older)],
		next_offset: null,
	});
	client.setQueryData(otherKey, otherHistory);
	client.setQueryData(["translation-task", active.id], active);
	client.setQueryData(["translation-result", deleted.id], deleted);
	client.setQueryData(["translation-result", older.id], older);
	client.setQueryData(
		["segment-translations", "saved"],
		[deleted, older, other],
	);
	client.setQueryData(["material-translation-activity", "book"], activity);
	client.setQueryData(chapterKey, {
		pages: [
			{
				items: [chapterItem(deleted, 3), chapterItem(other)],
				next_cursor: null,
				unavailable_count: 0,
			},
		],
		pageParams: [null],
	});
	try {
		await applyTranslationRemoval(
			client,
			"book",
			singleReceipt(deleted, latest, 2),
		);
		const chapter = client.getQueryData<{
			pages: { items: ReturnType<typeof chapterItem>[] }[];
		}>(chapterKey);
		assert.deepEqual(chapter?.pages[0]?.items, [
			{
				...chapterItem(latest, 2),
				translation_excerpt: `${"😀".repeat(159)}猫`,
			},
			chapterItem(other),
		]);
		assert.equal(
			client.getQueryData(["translation-result", latest.id]),
			latest,
		);
		assert.equal(client.getQueryData(["translation-result", older.id]), older);
		assert.equal(client.getQueryData(["translation-task", active.id]), active);
		assert.deepEqual(
			client.getQueryData(["material-translation-activity", "book"]),
			{
				tasks: [taskFor(latest), active, otherTask],
				resultIds: [latest.id, older.id, other.id],
			},
		);
		assert.deepEqual(
			client.getQueryData<TranslationResult[]>([
				"segment-translations",
				"saved",
			]),
			[{ ...deleted, reader_deleted: true }, older, other],
		);
		assert.equal(client.getQueryData(firstKey), undefined);
		assert.equal(client.getQueryData(nextKey), undefined);
		assert.equal(client.getQueryData(otherKey), otherHistory);
		assert.equal(client.getQueryState(otherKey)?.isInvalidated, false);
	} finally {
		client.clear();
	}
});

test("deleting an older version keeps the latest chapter entry with authoritative count", async () => {
	const client = new QueryClient();
	const latest = result();
	const older = { ...latest, id: "older", task_id: "older-task" };
	const key = ["material-chapter-translations", "book", "version", "chapter"];
	client.setQueryData(key, {
		pages: [
			{
				items: [chapterItem(latest, 4)],
				next_cursor: null,
				unavailable_count: 0,
			},
		],
		pageParams: [null],
	});
	try {
		await applyTranslationRemoval(
			client,
			"book",
			singleReceipt(older, latest, 3),
		);
		assert.deepEqual(
			client.getQueryData<{
				pages: { items: ReturnType<typeof chapterItem>[] }[];
			}>(key)?.pages[0]?.items,
			[chapterItem(latest, 3)],
		);
	} finally {
		client.clear();
	}
});

test("deleting the last successful version removes only its chapter entry and retains an ongoing retry", async () => {
	const client = new QueryClient();
	const deleted = result();
	const other = result(20);
	const active = { ...taskFor(deleted, "running"), id: "retry" };
	const key = ["material-chapter-translations", "book", "version", "chapter"];
	client.setQueryData(key, {
		pages: [
			{
				items: [chapterItem(deleted), chapterItem(other)],
				next_cursor: null,
				unavailable_count: 0,
			},
		],
		pageParams: [null],
	});
	client.setQueryData(["material-translation-activity", "book"], {
		tasks: [taskFor(deleted), active],
		resultIds: [deleted.id, other.id],
	});
	client.setQueryData(["translations", "book", deleted.identity_sha256, 0], {
		tasks: [taskFor(deleted), active],
		results: [deleted],
		next_offset: null,
	});
	try {
		await applyTranslationRemoval(client, "book", singleReceipt(deleted, null));
		assert.deepEqual(
			client.getQueryData<{
				pages: { items: ReturnType<typeof chapterItem>[] }[];
			}>(key)?.pages[0]?.items,
			[chapterItem(other)],
		);
		assert.deepEqual(
			client.getQueryData(["material-translation-activity", "book"]),
			{ tasks: [active], resultIds: [other.id] },
		);
		assert.equal(
			client.getQueryState(["translations", "book", deleted.identity_sha256, 0])
				?.status,
			"pending",
		);
	} finally {
		client.clear();
	}
});

test("late reads cannot restore removed history, chapter, detail or Segment facts while unrelated reads complete", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { gcTime: Infinity, retry: false } },
	});
	const deleted = result();
	const latest = { ...deleted, id: "remaining", task_id: "remaining-task" };
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
	const remainingKey = ["translation-result", latest.id];
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
				results: [deleted, latest],
				tasks: [taskFor(deleted), active],
				next_offset: null,
			},
		],
		[detailKey, deleted],
		[remainingKey, { ...latest, translation: "陈旧读值" }],
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
		await applyTranslationRemoval(
			client,
			"book",
			singleReceipt(deleted, latest),
		);
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
		assert.deepEqual(client.getQueryData(remainingKey), latest);
		assert.equal(
			client.getQueryData<{
				pages: { items: ReturnType<typeof chapterItem>[] }[];
			}>(chapterKey)?.pages[0]?.items[0]?.result_id,
			latest.id,
		);
		assert.equal(client.getQueryData(taskKey), active);
		assert.equal(client.getQueryState(taskKey)?.status, "success");
		assert.equal(client.getQueryState(otherKey)?.status, "success");
		assert.equal(client.getQueryState(otherKey)?.isInvalidated, false);
	} finally {
		client.clear();
	}
});
