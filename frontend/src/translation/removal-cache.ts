import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { components } from "../api/schema";
import type {
	TranslationRemoval,
	TranslationResult,
	TranslationTask,
} from "./api.ts";
import type { TranslationHistory } from "./session.ts";

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

/** A removed target must not be republished by a read already in flight. */
export async function cancelTranslationReads(
	client: QueryClient,
	materialId: string,
	removed?: TranslationRemoval,
): Promise<void> {
	await client.cancelQueries({
		predicate: (query) =>
			belongsToMaterial(query, materialId) ||
			(query.queryKey[0] === "translation-result" &&
				removed?.result_ids.includes(String(query.queryKey[1])) === true) ||
			(query.queryKey[0] === "translation-task" &&
				removed?.task_ids.includes(String(query.queryKey[1])) === true),
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
	client.setQueriesData<TranslationHistory>(
		{ queryKey: ["translations", materialId] },
		(history) =>
			history && {
				...history,
				tasks: history.tasks.filter((task) => !taskIds.has(task.id)),
				results: history.results.filter((result) => !resultIds.has(result.id)),
			},
	);
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
					items: page.items.filter(
						(item) => item.identity_sha256 !== removed.identity_sha256,
					),
				})),
			},
	);
	for (const id of resultIds)
		client.setQueryData<TranslationResult>(
			["translation-result", id],
			(result) => result && { ...result, reader_deleted: true },
		);
	for (const id of taskIds)
		client.removeQueries({ queryKey: ["translation-task", id], exact: true });
	client.setQueriesData<TranslationResult[]>(
		{ queryKey: ["segment-translations"] },
		(results) =>
			results?.map((result) =>
				resultIds.has(result.id) ? { ...result, reader_deleted: true } : result,
			),
	);
	void client.invalidateQueries({
		predicate: (query) => belongsToMaterial(query, materialId),
	});
	void client.invalidateQueries({ queryKey: ["segment-translations"] });
}
