import { api } from "../api/client";
import type { components, paths } from "../api/schema";
import { requireData } from "../content";
import { matchesStatistics } from "./statistics";
export type Book = components["schemas"]["MaterialCatalogItem"];
export type Usage = components["schemas"]["MaterialUsageResponse"];
export type BookQuery = NonNullable<
	paths["/api/materials"]["get"]["parameters"]["query"]
>;
export type SourceQuery = NonNullable<
	paths["/api/catalog/sources"]["get"]["parameters"]["query"]
>;
export type SegmentQuery = NonNullable<
	paths["/api/sources/{source_id}/catalog/segments"]["get"]["parameters"]["query"]
>;
export type AnalysisQuery = NonNullable<
	paths["/api/sources/{source_id}/catalog/analyses"]["get"]["parameters"]["query"]
>;
export const catalogKeys = {
	all: ["catalog"] as const,
	books: (query: BookQuery) => ["catalog", "books", query] as const,
	sources: (query: SourceQuery) => ["catalog", "sources", query] as const,
	segments: (id: string, query: SegmentQuery) =>
		["catalog", "segments", id, query] as const,
	analyses: (id: string, query: AnalysisQuery) =>
		["catalog", "analyses", id, query] as const,
};
export async function catalogBooks(query: BookQuery) {
	const { data, error, response } = await api.GET("/api/materials", {
		params: { query },
	});
	return requireData(data, error, response.status);
}
export async function catalogSources(query: SourceQuery) {
	const { data, error, response } = await api.GET("/api/catalog/sources", {
		params: { query },
	});
	return requireData(data, error, response.status);
}
export async function catalogSegments(id: string, query: SegmentQuery) {
	const { data, error, response } = await api.GET(
		"/api/sources/{source_id}/catalog/segments",
		{ params: { path: { source_id: id }, query } },
	);
	return requireData(data, error, response.status);
}
export async function catalogAnalyses(id: string, query: AnalysisQuery) {
	const { data, error, response } = await api.GET(
		"/api/sources/{source_id}/catalog/analyses",
		{ params: { path: { source_id: id }, query } },
	);
	return requireData(data, error, response.status);
}
export async function catalogUsage(id: string) {
	const { data, error, response } = await api.GET(
		"/api/materials/{material_id}/usage",
		{ params: { path: { material_id: id } } },
	);
	return requireData(data, error, response.status);
}
export async function updateUsage(
	id: string,
	status: Usage["status"],
	revision: number,
) {
	const { data, error, response } = await api.PUT(
		"/api/materials/{material_id}/usage",
		{
			params: { path: { material_id: id } },
			body: { status, expected_revision: revision },
		},
	);
	return requireData(data, error, response.status);
}

export type BookDetails = components["schemas"]["MaterialDetailsResponse"];
export type BookStatisticsData =
	components["schemas"]["MaterialStatisticsResponse"];
export async function getBookStatistics(
	id: string,
	versionId: string,
	generationId?: string,
	signal?: AbortSignal,
): Promise<BookStatisticsData> {
	const { data, error, response } = await api.GET(
		"/api/materials/{material_id}/statistics",
		{
			params: {
				path: { material_id: id },
				query: { version_id: versionId, generation_id: generationId },
			},
			signal,
		},
	);
	const result = requireData(data, error, response.status);
	if (!matchesStatistics(result, id, versionId, generationId))
		throw new Error("统计结果与当前书籍版本不一致，请重新加载。");
	return result;
}
export type BookMetadataUpdate =
	components["schemas"]["MaterialMetadataUpdate"];
export const bookDetailsKey = (id: string) => ["book-details", id] as const;
export async function getBookDetails(id: string) {
	const { data, error, response } = await api.GET(
		"/api/materials/{material_id}/details",
		{ params: { path: { material_id: id } } },
	);
	return requireData(data, error, response.status);
}
export async function updateBookMetadata(id: string, body: BookMetadataUpdate) {
	const { data, error, response } = await api.PATCH(
		"/api/materials/{material_id}/metadata",
		{ params: { path: { material_id: id } }, body },
	);
	return requireData(data, error, response.status);
}
