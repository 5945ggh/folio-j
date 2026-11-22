import type { QueryClient, QueryKey } from "@tanstack/react-query";

export function newestRevision<T extends { revision: number }>(
	current: T | undefined,
	response: T,
): T {
	return current && current.revision > response.revision ? current : response;
}

export async function commitVersionedSettings<T extends { revision: number }>(
	client: QueryClient,
	queryKey: QueryKey,
	response: T,
): Promise<T> {
	await client.cancelQueries({ queryKey, exact: true });
	const persisted = newestRevision(client.getQueryData<T>(queryKey), response);
	client.setQueryData(queryKey, persisted);
	return persisted;
}
