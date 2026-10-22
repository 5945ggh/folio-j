/** Publish a complete chapter so a hit never freezes a partial overlap list. */
export function completeChapterMarks<T extends { segment_id: string }>(
	pages: { items: T[]; next_cursor: string | null }[] | undefined,
): T[] {
	if (!pages?.length || pages.at(-1)?.next_cursor !== null) return [];
	const records = new Map<string, T>();
	for (const page of pages)
		for (const item of page.items) records.set(item.segment_id, item);
	return [...records.values()];
}
