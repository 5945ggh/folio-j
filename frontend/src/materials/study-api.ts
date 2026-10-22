import { api } from "../api/client";
import type { components } from "../api/schema";
import { errorMessage, RequestError } from "../content";
import type { Chapter } from "./api";

export type MaterialProvenance = components["schemas"]["MaterialProvenance"];
export type SegmentProvenance =
	components["schemas"]["SegmentProvenanceResponse"];
export type MaterialSegmentInput = components["schemas"]["SegmentCreate"];
export type StudyTarget = { reference: MaterialProvenance; chapter: Chapter };
export type ChapterSegment = components["schemas"]["MaterialChapterSegment"];
export const chapterSegmentsKey = (
	materialId: string,
	versionId: string,
	chapterId: string,
) => ["material-chapter-segments", materialId, versionId, chapterId] as const;

export async function getChapterSegments(
	materialId: string,
	versionId: string,
	chapterId: string,
	after: string | null,
	signal?: AbortSignal,
) {
	const response = await api.GET(
		"/api/materials/{material_id}/chapters/{chapter_id}/segments",
		{
			params: {
				path: { material_id: materialId, chapter_id: chapterId },
				query: {
					version_id: versionId,
					...(after ? { after } : {}),
					limit: 100,
				},
			},
			signal,
		},
	);
	return result(response.data, response.error, response.response.status);
}

function result<T>(data: T | undefined, error: unknown, status: number): T {
	if (data !== undefined) return data;
	const detail =
		error && typeof error === "object" && "detail" in error
			? error.detail
			: null;
	if (
		detail &&
		typeof detail === "object" &&
		"message" in detail &&
		typeof detail.message === "string"
	)
		throw new RequestError(detail.message, status);
	throw errorMessage(error, status);
}

export async function getSegmentProvenance(id: string, signal?: AbortSignal) {
	const response = await api.GET(
		"/api/segments/{segment_id}/material-provenance",
		{
			params: { path: { segment_id: id } },
			signal,
		},
	);
	return result(response.data, response.error, response.response.status);
}

export async function matchMaterialSegments(
	sourceId: string,
	reference: MaterialProvenance,
	signal?: AbortSignal,
) {
	const response = await api.POST(
		"/api/sources/{source_id}/segments/material-provenance/matches",
		{
			params: { path: { source_id: sourceId } },
			body: reference,
			signal,
		},
	);
	return result(response.data, response.error, response.response.status);
}

export async function selectMaterialSegment(
	segmentId: string,
	reference: MaterialProvenance,
) {
	const response = await api.POST(
		"/api/segments/{segment_id}/material-provenance/select",
		{
			params: { path: { segment_id: segmentId } },
			body: reference,
		},
	);
	return result(response.data, response.error, response.response.status);
}

export async function createMaterialSegment(
	sourceId: string,
	body: MaterialSegmentInput,
) {
	const response = await api.POST("/api/sources/{source_id}/segments", {
		params: { path: { source_id: sourceId } },
		body,
	});
	return result(response.data, response.error, response.response.status);
}
