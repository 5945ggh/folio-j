import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { components } from "../api/schema";
import type { Segment } from "../content";

export type SegmentDeleteImpact = components["schemas"]["SegmentDeleteImpact"];

/** Every reported field is part of the user's confirmation, including identity. */
export function sameSegmentDeleteImpact(
	confirmed: SegmentDeleteImpact,
	fresh: SegmentDeleteImpact,
): boolean {
	const keys = Object.keys(confirmed) as (keyof SegmentDeleteImpact)[];
	return (
		keys.length === Object.keys(fresh).length &&
		keys.every((key) => confirmed[key] === fresh[key])
	);
}

function records(data: unknown): Record<string, unknown>[] {
	if (Array.isArray(data)) return data.flatMap(records);
	if (!data || typeof data !== "object") return [];
	const record = data as Record<string, unknown>;
	return [record, ...records(record.items), ...records(record.pages)];
}

/** Preserve pagination metadata while removing the deleted row from mounted views. */
function withoutSegment(data: unknown, segmentId: string): unknown {
	if (Array.isArray(data))
		return data
			.filter(
				(item) =>
					!item ||
					typeof item !== "object" ||
					(item.id !== segmentId && item.segment_id !== segmentId),
			)
			.map((item) => withoutSegment(item, segmentId));
	if (!data || typeof data !== "object") return data;
	const record = data as Record<string, unknown>;
	return Object.fromEntries(
		Object.entries(record).map(([key, value]) => [
			key,
			key === "items" || key === "pages" || key === "segments"
				? withoutSegment(value, segmentId)
				: value,
		]),
	);
}

/** Retire pending reads before eviction so late results cannot restore deleted content. */
export async function refreshAfterSegmentDeletion(
	client: QueryClient,
	segment: Pick<Segment, "id" | "source_id" | "material_provenance">,
): Promise<void> {
	const cached = client.getQueryCache().getAll();
	const analysisIds = new Set<string>();
	const threadIds = new Set<string>();
	const jobIds = new Set<string>();
	for (const query of cached) {
		const [kind, id] = query.queryKey;
		for (const record of records(query.state.data)) {
			if (
				record.segment_id !== segment.id &&
				!((kind === "analyses" || kind === "chat-threads") && id === segment.id)
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
		["segment", segment.id],
		["segments", segment.id],
		["segment-edit-current", segment.id],
		["segment-delete-impact", segment.id],
		["segment-translations", segment.id],
		["analyses", segment.id],
		["chat-threads", segment.id],
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
		["source-segments", segment.source_id],
		["source", segment.source_id],
		["sources"],
		["source-delete-impact", segment.source_id],
		["catalog"],
		["source-entry"],
		["material-segment-matches", segment.source_id],
	];
	if (segment.material_provenance) {
		const materialId = segment.material_provenance.material_id;
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
			predicate: ({ queryKey: [kind, scope, source] }) =>
				(kind === "source-segments" && scope === segment.source_id) ||
				(kind === "catalog" &&
					(scope === "segments" || scope === "analyses") &&
					source === segment.source_id) ||
				(kind === "material-segment-matches" && scope === segment.source_id) ||
				(kind === "material-chapter-segments" &&
					scope === segment.material_provenance?.material_id),
		},
		(data) => withoutSegment(data, segment.id),
	);
	// Inactive views must fetch before showing old lists or reader marks again.
	for (const queryKey of refreshedQueries)
		client.removeQueries({ queryKey, type: "inactive" });
	await Promise.all(
		refreshedQueries.map((queryKey) => client.invalidateQueries({ queryKey })),
	);
}
