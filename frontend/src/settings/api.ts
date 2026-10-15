import { api } from "../api/client";
import type { components, paths } from "../api/schema";
import { requireData } from "../content";
import { settingsQueryKey } from "./settings-cache";

export type Settings = components["schemas"]["SettingsResponse"];
export type Style = components["schemas"]["StyleResponse"];
export type ProfileInput = components["schemas"]["ProfileInput"];
export type StyleInput = components["schemas"]["StyleInput"];
export type DefaultsInput = components["schemas"]["DefaultsInput"];
export type SettingsPatch = components["schemas"]["SettingsPatch"];
export type DefaultsPatch = components["schemas"]["DefaultsPatch"];
export type Provider = components["schemas"]["ProviderResponse"];
export type ProviderInput = components["schemas"]["ProviderInput"];
export type Model = components["schemas"]["ModelResponse"];
export type ModelInput = components["schemas"]["ModelInput"];
export type Run = components["schemas"]["RunResponse"];
export type RunFilters = Pick<
	NonNullable<paths["/api/runs"]["get"]["parameters"]["query"]>,
	"provider_id" | "model_id" | "status"
>;

export const settingsKeys = {
	settings: settingsQueryKey,
	providers: ["providers"] as const,
	runs: ["runs"] as const,
	runsPage: (page: number, filters: RunFilters = {}) =>
		["runs", "page", page, filters] as const,
	run: (id: string) => ["runs", id] as const,
};

export async function getSettings() {
	const { data, error, response } = await api.GET("/api/settings");
	return requireData(data, error, response.status);
}

export async function patchSettings(body: SettingsPatch) {
	const { data, error, response } = await api.PATCH("/api/settings", { body });
	return requireData(data, error, response.status);
}

export async function getProviders() {
	const { data, error, response } = await api.GET("/api/providers");
	return requireData(data, error, response.status);
}

export async function getRuns(
	limit: number,
	offset: number,
	filters: RunFilters = {},
) {
	const { data, error, response } = await api.GET("/api/runs", {
		params: { query: { limit, offset, ...filters } },
	});
	return requireData(data, error, response.status);
}

export async function getRun(id: string) {
	const { data, error, response } = await api.GET("/api/runs/{run_id}", {
		params: { path: { run_id: id } },
	});
	return requireData(data, error, response.status);
}
