import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { chapterSegmentsKey, getChapterSegments } from "./study-api";
import { completeChapterMarks } from "./study-marks";

export function useChapterStudyMarks(
	materialId: string,
	versionId: string,
	chapterId: string,
	enabled: boolean,
) {
	const query = useInfiniteQuery({
		queryKey: chapterSegmentsKey(materialId, versionId, chapterId),
		queryFn: ({ pageParam, signal }) =>
			getChapterSegments(materialId, versionId, chapterId, pageParam, signal),
		initialPageParam: null as string | null,
		getNextPageParam: (page) => page.next_cursor ?? undefined,
		enabled: enabled && Boolean(chapterId),
		refetchOnMount: "always",
		retry: false,
	});
	const { hasNextPage, isFetching, isError, fetchNextPage } = query;
	useEffect(() => {
		if (enabled && hasNextPage && !isFetching && !isError) void fetchNextPage();
	}, [enabled, hasNextPage, isFetching, isError, fetchNextPage]);
	const items = useMemo(() => {
		if (!enabled || query.isError || !query.isFetchedAfterMount) return [];
		return completeChapterMarks(query.data?.pages);
	}, [enabled, query.data, query.isError, query.isFetchedAfterMount]);
	return {
		...query,
		items,
		loading: enabled && !isError && (!query.isFetchedAfterMount || hasNextPage),
		unavailable:
			query.data?.pages.reduce(
				(sum, page) => sum + page.unavailable_count,
				0,
			) ?? 0,
	};
}
