import type { QueryClient } from "@tanstack/react-query";

export const settingsQueryKey = ["settings"] as const;

export async function commitSettingsResponse<T>(
	client: QueryClient,
	response: T,
	accept: () => void,
) {
	await client.cancelQueries({ queryKey: settingsQueryKey });
	client.setQueryData(settingsQueryKey, response);
	accept();
}
