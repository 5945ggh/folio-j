import { api } from "../api/client";
import type { components } from "../api/schema";
import { requireData } from "../content";

export type DictionaryRequest =
	components["schemas"]["DictionaryLookupRequest"];
export type DictionaryMatch = components["schemas"]["DictionaryMatch"];
export type DictionaryNode = DictionaryMatch["definitions"][number];

export const dictionaryKey = ["dictionary", "installed"] as const;

export async function getDictionary(signal?: AbortSignal) {
	const { data, error, response } = await api.GET("/api/dictionary", {
		signal,
	});
	return requireData(data, error, response.status);
}

export async function importDictionary(file: File) {
	const { data, error, response } = await api.POST("/api/dictionary/import", {
		headers: { "Content-Type": "application/zip" },
		body: "",
		bodySerializer: () => file,
	});
	return requireData(data, error, response.status);
}

export async function lookupDictionary(
	body: DictionaryRequest,
	signal?: AbortSignal,
) {
	const { data, error, response } = await api.POST("/api/dictionary/lookup", {
		body,
		signal,
	});
	return requireData(data, error, response.status);
}
