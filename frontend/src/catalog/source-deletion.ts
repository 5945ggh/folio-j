import type { QueryClient } from "@tanstack/react-query";
import type { Segment } from "../content";
import { segmentCacheKeys } from "../segments/deletion.ts";

type OwnedItem = Pick<Segment, "id" | "source_id">;

export async function forgetSourceDetails(
	client: QueryClient,
	sourceId: string,
) {
	const ownedIds = (detailKey: string, listKey: string) => {
		const ids = new Set<string>();
		for (const [, item] of client.getQueriesData<OwnedItem>({
			queryKey: [detailKey],
		})) {
			if (item?.source_id === sourceId) ids.add(item.id);
		}
		for (const [, page] of client.getQueriesData<{ items: OwnedItem[] }>({
			queryKey: ["catalog", listKey],
		})) {
			for (const item of page?.items ?? [])
				if (item.source_id === sourceId) ids.add(item.id);
		}
		return ids;
	};
	const segments = ownedIds("segment", "segments");
	const books = ownedIds("book-details", "books");
	const keys = [
		...[...segments].flatMap(segmentCacheKeys),
		...[...books].map((id) => ["book-details", id]),
		["source-segments", sourceId],
		["source", sourceId],
	];
	await Promise.all(keys.map((queryKey) => client.cancelQueries({ queryKey })));
	for (const queryKey of keys) client.removeQueries({ queryKey });
}
