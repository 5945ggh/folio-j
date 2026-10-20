import { api } from "../api/client";
import type { components } from "../api/schema";
import { errorMessage, requireData } from "../content";
import { analysisWriteError } from "./editor";

export type AnalysisItem = components["schemas"]["AnalysisListItem"];
export type AnalysisDetail = components["schemas"]["AnalysisDetail"];
export type AnalysisImpact = components["schemas"]["AnalysisDeleteImpact"];
export type ManualAnalysisCreate =
	components["schemas"]["ManualAnalysisCreate"];
export type ManualAnalysisRevisionCreate =
	components["schemas"]["ManualAnalysisRevisionCreate"];

export async function createManualAnalysis(
	segmentId: string,
	body: ManualAnalysisCreate,
): Promise<AnalysisDetail> {
	const { data, error, response } = await api.POST(
		"/api/segments/{segment_id}/analyses",
		{ params: { path: { segment_id: segmentId } }, body },
	);
	if (!data) throw analysisWriteError(error, response.status);
	if (data.segment_id !== segmentId) throw analysisWriteError(undefined, 200);
	return data;
}

export async function createManualAnalysisRevision(
	analysisId: string,
	body: ManualAnalysisRevisionCreate,
): Promise<AnalysisDetail> {
	const { data, error, response } = await api.POST(
		"/api/analyses/{analysis_id}/revisions",
		{ params: { path: { analysis_id: analysisId } }, body },
	);
	if (!data) throw analysisWriteError(error, response.status);
	if (data.id !== analysisId) throw analysisWriteError(undefined, 200);
	return data;
}

export const analysisKeys = {
	list: (segmentId: string) => ["analyses", segmentId] as const,
	detail: (analysisId: string, revisionId?: string | null) =>
		["analysis", analysisId, revisionId ?? "current"] as const,
	impact: (analysisId: string) => ["analysis-impact", analysisId] as const,
};

export async function listAnalyses(segmentId: string, offset = 0) {
	const { data, error, response } = await api.GET(
		"/api/segments/{segment_id}/analyses",
		{
			params: {
				path: { segment_id: segmentId },
				query: { limit: 100, offset },
			},
		},
	);
	return requireData(data, error, response.status);
}

export async function getAnalysis(
	analysisId: string,
	revisionId?: string | null,
) {
	const { data, error, response } = await api.GET(
		"/api/analyses/{analysis_id}",
		{
			params: {
				path: { analysis_id: analysisId },
				query: { revision_id: revisionId ?? undefined },
			},
		},
	);
	return requireData(data, error, response.status);
}

export async function getAnalysisImpact(analysisId: string) {
	const { data, error, response } = await api.GET(
		"/api/analyses/{analysis_id}/delete-impact",
		{ params: { path: { analysis_id: analysisId } } },
	);
	return requireData(data, error, response.status);
}

export async function deleteAnalysis(analysisId: string) {
	const { error, response } = await api.DELETE("/api/analyses/{analysis_id}", {
		params: { path: { analysis_id: analysisId } },
	});
	if (error || !response.ok) throw errorMessage(error, response.status);
}
