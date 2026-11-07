import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { refreshAfterSegmentsDeletion } from "../segments/deletion.ts";
import { forgetDeletedMaterialImports } from "./import-state.ts";

/** Cancel before eviction so a late reader response cannot restore deleted text. */
export async function refreshAfterBookDeletion(
	client: QueryClient,
	materialId: string,
	sourceId: string,
	deletedSegmentIds: readonly string[] = [],
): Promise<void> {
	forgetDeletedMaterialImports(client, materialId);
	const materialQueries: QueryKey[] = [
		["materials", materialId],
		["book-details", materialId],
		["book-statistics", materialId],
		["material-delete-impact", materialId],
		["material-chapter-segments", materialId],
		["translations", materialId],
		["material-translation-activity", materialId],
		["material-chapter-translations", materialId],
	];
	for (const query of client.getQueryCache().getAll()) {
		const [kind] = query.queryKey;
		const data = query.state.data;
		if (
			(kind === "translation-result" || kind === "translation-task") &&
			((data &&
				typeof data === "object" &&
				"material_id" in data &&
				data.material_id === materialId) ||
				(data === undefined && query.state.fetchStatus === "fetching"))
		)
			materialQueries.push(query.queryKey);
	}
	const refreshedQueries: QueryKey[] = [
		["catalog"],
		["sources"],
		["source", sourceId],
		["source-entry"],
		["source-delete-impact", sourceId],
		["source-segments", sourceId],
		["material-segment-matches", sourceId],
	];
	await Promise.all(
		[...materialQueries, ...refreshedQueries].map((queryKey) =>
			client.cancelQueries({ queryKey }),
		),
	);
	if (deletedSegmentIds.length) {
		await refreshAfterSegmentsDeletion(
			client,
			{
				ids: deletedSegmentIds,
				sourceId,
				materialId,
			},
			false,
		);
	}
	for (const queryKey of materialQueries) client.removeQueries({ queryKey });
	// Inactive lists do not refetch on invalidation. Evict their stale cards before
	// another catalog view subscribes and renders the cached deleted book.
	client.removeQueries({ queryKey: ["catalog", "books"], type: "inactive" });
	await Promise.all(
		refreshedQueries.map((queryKey) => client.invalidateQueries({ queryKey })),
	);
}
