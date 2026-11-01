import { api } from "../api/client";
import type { components } from "../api/schema";
import { requireData } from "../content";
export type TranslationResult =
	components["schemas"]["TranslationResultResponse"];
export type TranslationTask = components["schemas"]["TranslationTaskResponse"];
export type TranslationTargetRemoval =
	components["schemas"]["TranslationRemovalResponse"];
export type TranslationResultRemoval =
	components["schemas"]["TranslationResultRemovalResponse"];
export type TranslationRemoval =
	| TranslationTargetRemoval
	| TranslationResultRemoval;
export type TranslationSettings =
	components["schemas"]["TranslationSettingsResponse"];
export type TranslationSettingsInput =
	components["schemas"]["TranslationSettingsUpdate"];
export type TranslationInput = components["schemas"]["TranslationCreate"];
export type AdoptionInput = components["schemas"]["TranslationAdopt"];
export const translationSettingsKey = ["translation-settings"] as const;
export async function getTranslationSettings() {
	const { data, error, response } = await api.GET("/api/settings/translation");
	return requireData(data, error, response.status);
}
export async function saveTranslationSettings(body: TranslationSettingsInput) {
	const { data, error, response } = await api.PUT("/api/settings/translation", {
		body,
	});
	return requireData(data, error, response.status);
}
export async function getTranslationHistory(
	materialId: string,
	offset = 0,
	identity?: string,
	signal?: AbortSignal,
) {
	const { data, error, response } = await api.GET(
		"/api/materials/{material_id}/translations",
		{
			signal,
			params: {
				path: { material_id: materialId },
				query: {
					offset,
					limit: 15,
					...(identity ? { identity_sha256: identity } : {}),
				},
			},
		},
	);
	return requireData(data, error, response.status);
}
export async function createTranslation(
	materialId: string,
	body: TranslationInput,
) {
	const { data, error, response } = await api.POST(
		"/api/materials/{material_id}/translations",
		{ params: { path: { material_id: materialId } }, body },
	);
	return requireData(data, error, response.status);
}
export async function getTranslationTask(id: string, signal?: AbortSignal) {
	const { data, error, response } = await api.GET(
		"/api/translation-tasks/{task_id}",
		{ params: { path: { task_id: id } }, signal },
	);
	return requireData(data, error, response.status);
}
export async function stopTranslation(id: string) {
	const { data, error, response } = await api.POST(
		"/api/translation-tasks/{task_id}/stop",
		{ params: { path: { task_id: id } } },
	);
	return requireData(data, error, response.status);
}
export async function getTranslationResult(id: string, signal?: AbortSignal) {
	const { data, error, response } = await api.GET(
		"/api/translation-results/{result_id}",
		{ params: { path: { result_id: id } }, signal },
	);
	return requireData(data, error, response.status);
}
export async function removeTranslation(materialId: string, identity: string) {
	const { data, error, response } = await api.DELETE(
		"/api/materials/{material_id}/translations/{identity_sha256}",
		{
			params: {
				path: { material_id: materialId, identity_sha256: identity },
			},
		},
	);
	return requireData(data, error, response.status);
}
export async function removeTranslationResult(id: string) {
	const { data, error, response } = await api.DELETE(
		"/api/translation-results/{result_id}",
		{ params: { path: { result_id: id } } },
	);
	return requireData(data, error, response.status);
}
export async function adoptTranslation(id: string, body: AdoptionInput) {
	const { data, error, response } = await api.POST(
		"/api/translation-results/{result_id}/adopt",
		{ params: { path: { result_id: id } }, body },
	);
	return requireData(data, error, response.status);
}
export async function getSegmentTranslations(id: string) {
	const { data, error, response } = await api.GET(
		"/api/segments/{segment_id}/translation-results",
		{ params: { path: { segment_id: id } } },
	);
	return requireData(data, error, response.status);
}

export async function getTranslationDeleteImpact(id: string) {
	const { data, error, response } = await api.GET(
		"/api/materials/{material_id}/delete-impact",
		{ params: { path: { material_id: id } } },
	);
	return requireData(data, error, response.status);
}
