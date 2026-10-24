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
import { useReaderSessionRefresh } from "./reader-session-query";

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
export function useMaterialTranslationActivity(
	materialId: string,
	enabled = true,
	activation = 0,
) {
	const client = useQueryClient();
	const key = translationActivityKey(materialId);
	const query = useQuery({
		queryKey: key,
		enabled,
		staleTime: activation > 0 ? Number.POSITIVE_INFINITY : 0,
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
			enabled && current.state.data?.tasks.some(activeTranslation)
				? 1200
				: false,
	});
	useReaderSessionRefresh(key, query.refetch, enabled, activation);
	const published = query.data?.resultIds.join(":");
	useEffect(() => {
		if (enabled && published)
			void client.invalidateQueries({
				queryKey: chapterTranslationsKey(materialId),
			});
	}, [client, materialId, published, enabled]);
}

export function useChapterTranslations(
	materialId: string,
	versionId: string,
	chapterId: string,
	enabled = true,
	activation = 0,
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
		enabled: enabled && Boolean(chapterId),
		staleTime: activation > 0 ? Number.POSITIVE_INFINITY : 0,
		refetchOnMount: "always",
		retry: false,
	});
	const refreshed = useReaderSessionRefresh(
		chapterTranslationsKey(materialId, versionId, chapterId),
		query.refetch,
		enabled,
		activation,
	);
	const { hasNextPage, isFetching, isError, fetchNextPage } = query;
	useEffect(() => {
		if (refreshed && hasNextPage && !isFetching && !isError)
			void fetchNextPage();
	}, [refreshed, hasNextPage, isFetching, isError, fetchNextPage]);
	const items = useMemo(
		() =>
			!refreshed || query.isError || !query.isFetchedAfterMount
				? []
				: completeChapterTranslations(query.data?.pages),
		[refreshed, query.data, query.isError, query.isFetchedAfterMount],
	);
	return {
		...query,
		items,
		loading:
			enabled &&
			!isError &&
			(!refreshed || !query.isFetchedAfterMount || hasNextPage),
		unavailable: Math.max(
			0,
			...(query.data?.pages.map((page) => page.unavailable_count) ?? []),
		),
	};
}
