import type { AnalysisDetail, AnalysisItem } from "../analysis/api.ts";

/** Shared list pages retain their cache shape; ordering here only affects this view. */
export function previewAnalyses(
	pages: readonly (readonly AnalysisItem[])[] | undefined,
	segmentId: string,
): AnalysisItem[] {
	const unique = new Map<string, AnalysisItem>();
	for (const item of pages?.flat() ?? []) {
		if (item.segment_id === segmentId && !unique.has(item.id))
			unique.set(item.id, item);
	}
	return [...unique.values()].sort(
		(left, right) =>
			right.updated_at.localeCompare(left.updated_at) ||
			right.id.localeCompare(left.id),
	);
}

/** A response is readable only for the exact segment, analysis and saved revision. */
export function previewDocument(
	document: AnalysisDetail | undefined,
	segmentId: string,
	analysis: AnalysisItem | undefined,
): AnalysisDetail | null {
	return document &&
		analysis &&
		document.segment_id === segmentId &&
		document.id === analysis.id &&
		document.revision_id === analysis.current_revision_id
		? document
		: null;
}
