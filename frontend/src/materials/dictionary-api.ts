import type { QueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { components } from "../api/schema";
import { requireData } from "../content";

export type DictionaryRequest =
	components["schemas"]["DictionaryLookupRequest"];
export type DictionaryMatch = components["schemas"]["DictionaryMatch"];
export type DictionaryNode = DictionaryMatch["definitions"][number];
export type DictionaryLibrary = components["schemas"]["DictionaryLibrary"];
export type DictionaryStatus = components["schemas"]["DictionaryStatus"];

export const dictionaryKey = ["dictionary", "installed"] as const;
export const dictionaryLibraryKey = ["dictionary", "library"] as const;
const dictionaryChangeKey = "folio-j:dictionary-library-changed";

export async function getDictionaryLibrary(signal?: AbortSignal) {
	const { data, error, response } = await api.GET("/api/dictionary/library", {
		signal,
	});
	return requireData(data, error, response.status);
}

export async function installDictionary(file: File) {
	const { data, error, response } = await api.POST(
		"/api/dictionary/library/import",
		{
			headers: { "Content-Type": "application/zip" },
			body: "",
			bodySerializer: () => file,
		},
	);
	return requireData(data, error, response.status);
}

export async function selectDictionary(id: string) {
	const { data, error, response } = await api.PUT(
		"/api/dictionary/library/selection",
		{ body: { dictionary_id: id } },
	);
	return requireData(data, error, response.status);
}

export async function deleteDictionary(id: string, replacementId?: string) {
	const { data, error, response } = await api.DELETE(
		"/api/dictionary/library/{dictionary_id}",
		{
			params: {
				path: { dictionary_id: id },
				query: { replacement_dictionary_id: replacementId },
			},
		},
	);
	return requireData(data, error, response.status);
}

export async function updateDictionaryLibrary(
	client: QueryClient,
	data: DictionaryLibrary,
) {
	// A GET started before the mutation must not restore the previous selection.
	await Promise.all([
		client.cancelQueries({ queryKey: dictionaryKey }),
		client.cancelQueries({ queryKey: dictionaryLibraryKey }),
	]);
	const selected = data.dictionaries.find(
		(item) => item.dictionary_id === data.active_dictionary_id,
	);
	client.setQueryData(dictionaryLibraryKey, data);
	client.setQueryData<DictionaryStatus>(
		dictionaryKey,
		selected
			? { ...selected, ready: true }
			: {
					title: null,
					dictionary_id: null,
					revision: null,
					entry_count: 0,
					ready: false,
				},
	);
	if (typeof window !== "undefined") {
		try {
			window.localStorage.setItem(
				dictionaryChangeKey,
				`${Date.now()}:${Math.random()}`,
			);
		} catch {
			// Focus refetch and lookup's expected identity still verify the selection.
		}
	}
}

export function subscribeDictionaryLibrary(client: QueryClient) {
	const changed = (event: StorageEvent) => {
		if (event.key !== dictionaryChangeKey && event.key !== null) return;
		// Installing another dictionary does not change existing lookups. Recheck
		// only the library and selection; the reader reacts to an identity change.
		void Promise.all(
			[dictionaryKey, dictionaryLibraryKey].map(async (queryKey) => {
				await client.cancelQueries({ queryKey });
				await client.invalidateQueries({ queryKey });
			}),
		);
	};
	window.addEventListener("storage", changed);
	return () => window.removeEventListener("storage", changed);
}

export async function getDictionary(signal?: AbortSignal) {
	const { data, error, response } = await api.GET("/api/dictionary", {
		signal,
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
