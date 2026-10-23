import {
	useInfiniteQuery,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { api } from "../api/client";
import type { components } from "../api/schema";
import { requireData } from "../content";
import {
	getTranslationHistory,
	getTranslationTask,
	type TranslationTask,
} from "../translation/api";
import { activeTranslation } from "../translation/state";
import { completeChapterTranslations } from "./chapter-records";

export type ChapterTranslation =
	components["schemas"]["MaterialChapterTranslation"];
export const chapterTranslationsKey = (
	materialId: string,
	versionId?: string,
	chapterId?: string,
) =>
	[
		"material-chapter-translations",
		materialId,
		...(versionId ? [versionId] : []),
		...(chapterId ? [chapterId] : []),
	] as const;

export const translationActivityKey = (materialId: string) =>
	["material-translation-activity", materialId] as const;
type TranslationActivity = { tasks: TranslationTask[]; resultIds: string[] };

/** Accepted work remains observable after its card is closed or replaced by another selection. */
export function useMaterialTranslationActivity(materialId: string) {
	const client = useQueryClient();
	const key = translationActivityKey(materialId);
	const query = useQuery({
		queryKey: key,
		queryFn: async (): Promise<TranslationActivity> => {
			const previous = client.getQueryData<TranslationActivity>(key);
			const recent = await getTranslationHistory(materialId);
			const missing = (previous?.tasks.filter(activeTranslation) ?? []).filter(
				(task) => !recent.tasks.some((item) => item.id === task.id),
			);
			const tracked = await Promise.all(
				missing.map((task) => getTranslationTask(task.id)),
			);
			const tasks = [...recent.tasks, ...tracked];
			return {
				tasks,
				resultIds: [
					...new Set([
						...recent.results.map((result) => result.id),
						...tasks.flatMap((task) =>
							task.result_id ? [task.result_id] : [],
						),
					]),
				].sort(),
			};
		},
		refetchOnMount: "always",
		refetchInterval: (current) =>
			current.state.data?.tasks.some(activeTranslation) ? 1200 : false,
	});
	const published = query.data?.resultIds.join(":");
	useEffect(() => {
		if (published)
			void client.invalidateQueries({
				queryKey: chapterTranslationsKey(materialId),
			});
	}, [client, materialId, published]);
}

export function useChapterTranslations(
	materialId: string,
	versionId: string,
	chapterId: string,
) {
	const query = useInfiniteQuery({
		queryKey: chapterTranslationsKey(materialId, versionId, chapterId),
		queryFn: async ({ pageParam, signal }) => {
			const { data, error, response } = await api.GET(
				"/api/materials/{material_id}/chapters/{chapter_id}/translations",
				{
					params: {
						path: { material_id: materialId, chapter_id: chapterId },
						query: {
							version_id: versionId,
							limit: 100,
							...(pageParam ? { after: pageParam } : {}),
						},
					},
					signal,
				},
			);
			return requireData(data, error, response.status);
		},
		initialPageParam: null as string | null,
		getNextPageParam: (page) => page.next_cursor ?? undefined,
		enabled: Boolean(chapterId),
		refetchOnMount: "always",
		retry: false,
	});
	const { hasNextPage, isFetching, isError, fetchNextPage } = query;
	useEffect(() => {
		if (hasNextPage && !isFetching && !isError) void fetchNextPage();
	}, [hasNextPage, isFetching, isError, fetchNextPage]);
	const items = useMemo(
		() =>
			query.isError || !query.isFetchedAfterMount
				? []
				: completeChapterTranslations(query.data?.pages),
		[query.data, query.isError, query.isFetchedAfterMount],
	);
	return {
		...query,
		items,
		loading: !isError && (!query.isFetchedAfterMount || hasNextPage),
		unavailable: Math.max(
			0,
			...(query.data?.pages.map((page) => page.unavailable_count) ?? []),
		),
	};
}
