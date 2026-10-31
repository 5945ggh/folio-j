import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { type BookStatisticsData, getBookStatistics } from "./api";
import { bookStatisticsKey } from "./statistics";

/** Observe the current analysis while visible; immutable generations never poll. */
export function materialStatisticsOptions(
	materialId: string,
	versionId: string,
	generationId?: string,
) {
	return queryOptions({
		queryKey: bookStatisticsKey(materialId, versionId, generationId),
		queryFn: ({ signal }) =>
			getBookStatistics(materialId, versionId, generationId, signal),
		staleTime: generationId ? Number.POSITIVE_INFINITY : 0,
		refetchOnMount: "always",
		refetchOnWindowFocus: !generationId,
		refetchInterval: generationId ? false : 30_000,
		refetchIntervalInBackground: false,
	});
}

/** Publishing/preparing analysis updates mounted views without delaying reading. */
export function refreshMaterialAnalysis(
	client: QueryClient,
	materialId: string,
	versionId: string,
	generationId: string,
): void {
	const queryKey = bookStatisticsKey(materialId, versionId);
	const previous = client.getQueryData<BookStatisticsData>(queryKey);
	if (previous && previous.generation_id !== generationId)
		void client.invalidateQueries({ queryKey, exact: true });
}
