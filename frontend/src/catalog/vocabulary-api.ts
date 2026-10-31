import { api } from "../api/client";
import type { components, paths } from "../api/schema";
import { requireData } from "../content";

export type Vocabulary = components["schemas"]["MaterialVocabularyResponse"];
export type VocabularyItem = components["schemas"]["VocabularyItem"];
export type VocabularyOccurrences =
	components["schemas"]["MaterialVocabularyOccurrencesResponse"];
export type VocabularyOccurrence =
	components["schemas"]["MaterialVocabularyOccurrence"];
export type VocabularyQuery =
	paths["/api/materials/{material_id}/vocabulary"]["get"]["parameters"]["query"];
export type VocabularyOccurrencesQuery =
	paths["/api/materials/{material_id}/vocabulary/occurrences"]["get"]["parameters"]["query"];

export async function getVocabulary(
	id: string,
	query: VocabularyQuery,
	signal?: AbortSignal,
): Promise<Vocabulary> {
	const { data, error, response } = await api.GET(
		"/api/materials/{material_id}/vocabulary",
		{
			params: { path: { material_id: id }, query },
			signal,
		},
	);
	const result = requireData(data, error, response.status);
	if (
		result.material_id !== id ||
		result.version_id !== query.version_id ||
		(query.generation_id && result.generation_id !== query.generation_id)
	)
		throw new Error("词汇结果与当前材料版本不一致，请重新加载。");
	return result;
}

export async function getVocabularyOccurrences(
	id: string,
	query: VocabularyOccurrencesQuery,
	signal?: AbortSignal,
): Promise<VocabularyOccurrences> {
	const { data, error, response } = await api.GET(
		"/api/materials/{material_id}/vocabulary/occurrences",
		{
			params: { path: { material_id: id }, query },
			signal,
		},
	);
	const result = requireData(data, error, response.status);
	if (
		result.material_id !== id ||
		result.version_id !== query.version_id ||
		result.generation_id !== query.generation_id ||
		result.word !== query.word ||
		result.pos !== (query.pos || null)
	)
		throw new Error("出现位置与当前词汇不一致，请重新加载。");
	return result;
}
