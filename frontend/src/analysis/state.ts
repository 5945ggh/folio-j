export function readingAnalysis<T extends { id: string; segment_id: string }>(
	detail: T | undefined,
	segmentId: string,
	selectedId: string | null,
	isError = false,
): T | null {
	return !isError &&
		selectedId &&
		detail?.id === selectedId &&
		detail.segment_id === segmentId
		? detail
		: null;
}
