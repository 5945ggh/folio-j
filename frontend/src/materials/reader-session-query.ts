import {
	hashKey,
	type QueryClient,
	type QueryKey,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

/** A resumed observer must not join a request started before the reader was suspended. */
export async function refreshReaderSessionQuery(
	client: QueryClient,
	queryKey: QueryKey,
	refetch: () => Promise<unknown>,
	current: () => boolean,
): Promise<void> {
	await client.cancelQueries({ queryKey, exact: true });
	if (current()) await refetch();
}

/** Cached study data is withheld until this activation's explicit refresh finishes. */
export function useReaderSessionRefresh(
	queryKey: QueryKey,
	refetch: (options?: { cancelRefetch: boolean }) => Promise<unknown>,
	enabled: boolean,
	activation: number,
): boolean {
	const client = useQueryClient();
	const key = useRef(queryKey);
	key.current = queryKey;
	const queryHash = hashKey(queryKey);
	const [refreshed, setRefreshed] = useState({ activation: 0, queryHash });
	useEffect(() => {
		if (!enabled || activation === 0) return;
		let current = true;
		void refreshReaderSessionQuery(
			client,
			key.current,
			() => refetch({ cancelRefetch: false }),
			() => current,
		).finally(() => {
			if (current) setRefreshed({ activation, queryHash });
		});
		return () => {
			current = false;
		};
	}, [enabled, activation, refetch, client, queryHash]);
	return (
		enabled &&
		(activation === 0 ||
			(refreshed.activation === activation &&
				refreshed.queryHash === queryHash))
	);
}
