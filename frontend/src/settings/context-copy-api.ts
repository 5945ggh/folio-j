import { api } from "../api/client";
import type { components } from "../api/schema";
import { requireData } from "../content";

export type ContextCopySettings =
	components["schemas"]["ContextCopySettingsResponse"];
export type ContextCopyPreferences = Omit<ContextCopySettings, "revision">;
export type ContextCopySettingsUpdate =
	components["schemas"]["ContextCopySettingsUpdate"];

export async function getContextCopySettings(signal?: AbortSignal) {
	const { data, error, response } = await api.GET(
		"/api/settings/context-copy",
		{
			signal,
		},
	);
	return requireData(data, error, response.status);
}

export async function saveContextCopySettings(body: ContextCopySettingsUpdate) {
	const { data, error, response } = await api.PUT(
		"/api/settings/context-copy",
		{
			body,
		},
	);
	return requireData(data, error, response.status);
}
