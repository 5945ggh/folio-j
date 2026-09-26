import { api } from "../api/client";
import type { components } from "../api/schema";
import { requireData } from "../content";

export type Settings = components["schemas"]["SettingsResponse"];
export type Style = components["schemas"]["StyleResponse"];
export type ProfileInput = components["schemas"]["ProfileInput"];
export type StyleInput = components["schemas"]["StyleInput"];
export type DefaultsInput = components["schemas"]["DefaultsInput"];
export type Provider = components["schemas"]["ProviderResponse"];
export type ProviderInput = components["schemas"]["ProviderInput"];
export type Model = components["schemas"]["ModelResponse"];
export type ModelInput = components["schemas"]["ModelInput"];
export type Run = components["schemas"]["RunResponse"];

export const settingsKeys = {
	settings: ["settings"] as const,
	providers: ["providers"] as const,
	runs: ["runs"] as const,
	runsPage: (page: number) => ["runs", "page", page] as const,
	run: (id: string) => ["runs", id] as const,
};

export async function getSettings() {
	const { data, error, response } = await api.GET("/api/settings");
	return requireData(data, error, response.status);
}

export async function getProviders() {
	const { data, error, response } = await api.GET("/api/providers");
	return requireData(data, error, response.status);
}

export async function getRuns(limit: number, offset: number) {
	const { data, error, response } = await api.GET("/api/runs", {
		params: { query: { limit, offset } },
	});
	return requireData(data, error, response.status);
}

export async function getRun(id: string) {
	const { data, error, response } = await api.GET("/api/runs/{run_id}", {
		params: { path: { run_id: id } },
	});
	return requireData(data, error, response.status);
}
