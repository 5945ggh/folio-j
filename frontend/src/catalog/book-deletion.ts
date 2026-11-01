import type { QueryClient } from "@tanstack/react-query";
import { forgetDeletedMaterialImports } from "./import-state.ts";

/** Cancel before eviction so a late reader response cannot restore deleted text. */
export async function refreshAfterBookDeletion(
	client: QueryClient,
	materialId: string,
	sourceId: string,
): Promise<void> {
	forgetDeletedMaterialImports(client, materialId);
	const materialQueries = [
		["materials", materialId],
		["book-details", materialId],
		["book-statistics", materialId],
	];
	const refreshedQueries = [
		["catalog"],
		["sources"],
		["source", sourceId],
		["source-entry"],
		["source-delete-impact", sourceId],
	];
	await Promise.all(
		[...materialQueries, ...refreshedQueries].map((queryKey) =>
			client.cancelQueries({ queryKey }),
		),
	);
	for (const queryKey of materialQueries) client.removeQueries({ queryKey });
	// Inactive lists do not refetch on invalidation. Evict their stale cards before
	// another catalog view subscribes and renders the cached deleted book.
	client.removeQueries({ queryKey: ["catalog", "books"], type: "inactive" });
	await Promise.all(
		refreshedQueries.map((queryKey) => client.invalidateQueries({ queryKey })),
	);
}
