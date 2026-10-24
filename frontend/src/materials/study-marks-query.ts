import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { useReaderSessionRefresh } from "./reader-session-query";
import { chapterSegmentsKey, getChapterSegments } from "./study-api";
import { completeChapterMarks } from "./study-marks";

export function useChapterStudyMarks(
	materialId: string,
	versionId: string,
	chapterId: string,
	enabled: boolean,
	activation = 0,
) {
	const query = useInfiniteQuery({
		queryKey: chapterSegmentsKey(materialId, versionId, chapterId),
		queryFn: ({ pageParam, signal }) =>
			getChapterSegments(materialId, versionId, chapterId, pageParam, signal),
		initialPageParam: null as string | null,
		getNextPageParam: (page) => page.next_cursor ?? undefined,
		enabled: enabled && Boolean(chapterId),
		// Resumed queries refresh through the session ticket, without an earlier automatic request.
		staleTime: activation > 0 ? Number.POSITIVE_INFINITY : 0,
		refetchOnMount: "always",
		retry: false,
	});
	const refreshed = useReaderSessionRefresh(
		chapterSegmentsKey(materialId, versionId, chapterId),
		query.refetch,
		enabled,
		activation,
	);
	const { hasNextPage, isFetching, isError, fetchNextPage } = query;
	useEffect(() => {
		if (refreshed && hasNextPage && !isFetching && !isError)
			void fetchNextPage();
	}, [refreshed, hasNextPage, isFetching, isError, fetchNextPage]);
	const items = useMemo(() => {
		if (!refreshed || query.isError || !query.isFetchedAfterMount) return [];
		return completeChapterMarks(query.data?.pages);
	}, [refreshed, query.data, query.isError, query.isFetchedAfterMount]);
	return {
		...query,
		items,
		loading:
			enabled &&
			!isError &&
			(!refreshed || !query.isFetchedAfterMount || hasNextPage),
		unavailable:
			query.data?.pages.reduce(
				(sum, page) => sum + page.unavailable_count,
				0,
			) ?? 0,
	};
}
