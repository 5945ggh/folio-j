import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { components } from "../api/schema";
import type {
	TranslationRemoval,
	TranslationResult,
	TranslationTask,
} from "./api.ts";

type CachedQuery = {
	queryKey: readonly unknown[];
	state: { data: unknown };
};
type Activity = { tasks: TranslationTask[]; resultIds: string[] };
type ChapterTranslations = components["schemas"]["MaterialChapterTranslations"];

function belongsToMaterial(query: CachedQuery, materialId: string): boolean {
	const [kind, id] = query.queryKey;
	if (
		(kind === "translations" ||
			kind === "material-translation-activity" ||
			kind === "material-chapter-translations") &&
		id === materialId
	)
		return true;
	const data = query.state.data;
	return (
		(kind === "translation-result" || kind === "translation-task") &&
		typeof data === "object" &&
		data !== null &&
		"material_id" in data &&
		data.material_id === materialId
	);
}

function affectedHistory(
	query: CachedQuery,
	materialId: string,
	removed: TranslationRemoval,
): boolean {
	const [kind, id, identity] = query.queryKey;
	return (
		kind === "translations" &&
		id === materialId &&
		(identity === undefined || identity === removed.identity_sha256)
	);
}

function affectedRead(
	query: CachedQuery,
	materialId: string,
	removed: TranslationRemoval,
): boolean {
	const [kind, id] = query.queryKey;
	return (
		affectedHistory(query, materialId, removed) ||
		((kind === "material-translation-activity" ||
			kind === "material-chapter-translations") &&
			id === materialId) ||
		(kind === "translation-result" &&
			(removed.result_ids.includes(String(id)) ||
				("remaining_result" in removed &&
					removed.remaining_result?.id === id))) ||
		(kind === "translation-task" && removed.task_ids.includes(String(id))) ||
		// A pending Segment list may not yet reveal the affected result IDs.
		kind === "segment-translations"
	);
}

/** A removed result must not be republished by a read already in flight. */
export async function cancelTranslationReads(
	client: QueryClient,
	materialId: string,
	removed?: TranslationRemoval,
): Promise<void> {
	await client.cancelQueries({
		predicate: (query) =>
			removed
				? affectedRead(query, materialId, removed)
				: belongsToMaterial(query, materialId),
	});
}

/** Query remains the only owner of server facts; retained Segment snapshots stay readable. */
export async function applyTranslationRemoval(
	client: QueryClient,
	materialId: string,
	removed: TranslationRemoval,
): Promise<void> {
	await cancelTranslationReads(client, materialId, removed);
	const taskIds = new Set(removed.task_ids);
	const resultIds = new Set(removed.result_ids);
	const remaining =
		"remaining_result" in removed ? removed.remaining_result : null;
	client.setQueryData<Activity>(
		["material-translation-activity", materialId],
		(activity) =>
			activity && {
				tasks: activity.tasks.filter((task) => !taskIds.has(task.id)),
				resultIds: activity.resultIds.filter((id) => !resultIds.has(id)),
			},
	);
	client.setQueriesData<InfiniteData<ChapterTranslations>>(
		{ queryKey: ["material-chapter-translations", materialId] },
		(data) =>
			data && {
				...data,
				pages: data.pages.map((page) => ({
					...page,
					items: page.items.flatMap((item) => {
						if (item.identity_sha256 !== removed.identity_sha256) return [item];
						if (!remaining || !("remaining_result_count" in removed)) return [];
						return [
							{
								...item,
								result_id: remaining.id,
								translation_excerpt: [...remaining.translation]
									.slice(0, 160)
									.join(""),
								result_count: removed.remaining_result_count,
								target_language: remaining.target_language,
								created_at: remaining.created_at,
							},
						];
					}),
				})),
			},
	);
	for (const id of resultIds)
		client.setQueryData<TranslationResult>(
			["translation-result", id],
			(result) => result && { ...result, reader_deleted: true },
		);
	if (remaining)
		client.setQueryData(["translation-result", remaining.id], remaining);
	for (const id of taskIds)
		client.removeQueries({ queryKey: ["translation-task", id], exact: true });
	client.setQueriesData<TranslationResult[]>(
		{ queryKey: ["segment-translations"] },
		(results) =>
			results?.map((result) =>
				resultIds.has(result.id) ? { ...result, reader_deleted: true } : result,
			),
	);
	// Deletion shifts every offset. Clearing all affected pages also prevents a
	// filtered, incomplete head page from masquerading as complete empty history.
	void client.resetQueries({
		predicate: (query) => affectedHistory(query, materialId, removed),
	});
	void client.invalidateQueries({
		predicate: (query) =>
			query.queryKey[0] !== "translations" &&
			affectedRead(query, materialId, removed),
	});
}
