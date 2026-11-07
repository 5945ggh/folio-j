import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { Segment } from "../content";

function records(data: unknown): Record<string, unknown>[] {
	if (Array.isArray(data)) return data.flatMap(records);
	if (!data || typeof data !== "object") return [];
	const record = data as Record<string, unknown>;
	return [
		record,
		...records(record.items),
		...records(record.pages),
		...records(record.segments),
	];
}

/** Preserve pagination metadata while removing the deleted row from mounted views. */
function withoutSegments(
	data: unknown,
	segmentIds: ReadonlySet<string>,
): unknown {
	if (Array.isArray(data))
		return data
			.filter(
				(item) =>
					!item ||
					typeof item !== "object" ||
					(!segmentIds.has(item.id) && !segmentIds.has(item.segment_id)),
			)
			.map((item) => withoutSegments(item, segmentIds));
	if (!data || typeof data !== "object") return data;
	const record = data as Record<string, unknown>;
	return Object.fromEntries(
		Object.entries(record).map(([key, value]) => [
			key,
			key === "items" || key === "pages" || key === "segments"
				? withoutSegments(value, segmentIds)
				: value,
		]),
	);
}

/** Retire pending reads before eviction so late results cannot restore deleted content. */
export async function refreshAfterSegmentDeletion(
	client: QueryClient,
	segment: Pick<Segment, "id" | "source_id" | "material_provenance">,
): Promise<void> {
	return refreshAfterSegmentsDeletion(client, {
		ids: [segment.id],
		sourceId: segment.source_id,
		materialId: segment.material_provenance?.material_id,
	});
}

/** Batch related eviction and list refresh so a book deletion refetches each list once. */
export async function refreshAfterSegmentsDeletion(
	client: QueryClient,
	{
		ids,
		sourceId,
		materialId,
	}: {
		ids: readonly string[];
		sourceId: string;
		materialId?: string;
	},
	refresh = true,
): Promise<void> {
	const segmentIds = new Set(ids);
	const cached = client.getQueryCache().getAll();
	const analysisIds = new Set<string>();
	const threadIds = new Set<string>();
	const jobIds = new Set<string>();
	for (const query of cached) {
		const [kind, id] = query.queryKey;
		for (const record of records(query.state.data)) {
			if (
				!segmentIds.has(String(record.segment_id)) &&
				!(
					(kind === "analyses" || kind === "chat-threads") &&
					segmentIds.has(String(id))
				)
			)
				continue;
			if (typeof record.id !== "string") continue;
			if (
				kind === "analyses" ||
				kind === "analysis" ||
				(kind === "catalog" && id === "analyses")
			)
				analysisIds.add(record.id);
			if (kind === "chat-threads" || kind === "chat-thread") {
				threadIds.add(record.id);
				if (typeof record.active_job_id === "string")
					jobIds.add(record.active_job_id);
			}
		}
	}
	for (const query of cached) {
		for (const record of records(query.state.data))
			if (
				typeof record.thread_id === "string" &&
				threadIds.has(record.thread_id) &&
				typeof record.id === "string" &&
				(query.queryKey[0] === "chat-job" ||
					query.queryKey[0] === "chat-request")
			)
				jobIds.add(record.id);
	}
	const deletedQueries: QueryKey[] = [
		// A first detail read has no ownership data yet. Retire it conservatively;
		// known unrelated details retain their cache and can keep rendering.
		...cached
			.filter(
				({ queryKey: [kind], state }) =>
					state.data === undefined &&
					state.fetchStatus === "fetching" &&
					[
						"analysis",
						"analysis-impact",
						"chat-thread",
						"chat-messages",
						"chat-request",
						"chat-job",
					].includes(String(kind)),
			)
			.map(({ queryKey }) => queryKey),
		...ids.flatMap((id) => [
			["segment", id],
			["segments", id],
			["segment-edit-current", id],
			["segment-delete-impact", id],
			["segment-translations", id],
			["analyses", id],
			["chat-threads", id],
		]),
		...[...analysisIds].flatMap((id) => [
			["analysis", id],
			["analysis-impact", id],
		]),
		...[...threadIds].flatMap((id) => [
			["chat-thread", id],
			["chat-messages", id],
			["chat-request", id],
		]),
		...[...jobIds].map((id) => ["chat-job", id]),
	];
	const refreshedQueries: QueryKey[] = [
		["source-segments", sourceId],
		["source", sourceId],
		["sources"],
		["source-delete-impact", sourceId],
		["catalog"],
		["source-entry"],
		["material-segment-matches", sourceId],
	];
	if (materialId) {
		refreshedQueries.push(
			["material-chapter-segments", materialId],
			["book-details", materialId],
		);
	}
	await Promise.all(
		[...deletedQueries, ...refreshedQueries].map((queryKey) =>
			client.cancelQueries({ queryKey }),
		),
	);
	for (const queryKey of deletedQueries) client.removeQueries({ queryKey });
	// Keep deleted rows absent even if the subsequent list refresh fails.
	client.setQueriesData(
		{
			predicate: ({ queryKey: [kind, scope] }) =>
				(kind === "source-segments" && scope === sourceId) ||
				(kind === "catalog" &&
					(scope === "segments" || scope === "analyses")) ||
				(kind === "material-segment-matches" && scope === sourceId) ||
				(kind === "material-chapter-segments" && scope === materialId),
		},
		(data) => withoutSegments(data, segmentIds),
	);
	// Inactive views must fetch before showing old lists or reader marks again.
	for (const queryKey of refreshedQueries)
		client.removeQueries({ queryKey, type: "inactive" });
	if (refresh)
		await Promise.all(
			refreshedQueries.map((queryKey) =>
				client.invalidateQueries({ queryKey }),
			),
		);
}
