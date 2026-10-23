export type MarkInterval = { start: number; end: number };

/** Half-open text intervals; this never reads or changes the source text. */
export function subtractMarkIntervals(
	ranges: readonly MarkInterval[],
	covered: readonly MarkInterval[],
): MarkInterval[] {
	const union = (values: readonly MarkInterval[]): MarkInterval[] => {
		const result: MarkInterval[] = [];
		for (const range of [...values].sort((a, b) => a.start - b.start)) {
			if (range.end <= range.start) continue;
			const previous = result.at(-1);
			if (previous && range.start <= previous.end)
				previous.end = Math.max(previous.end, range.end);
			else result.push({ ...range });
		}
		return result;
	};
	const exclusions = union(covered);
	return union(ranges).flatMap(({ start, end }) => {
		const result: MarkInterval[] = [];
		let cursor = start;
		for (const range of exclusions) {
			if (range.end <= cursor) continue;
			if (range.start >= end) break;
			if (range.start > cursor)
				result.push({ start: cursor, end: range.start });
			cursor = Math.max(cursor, range.end);
			if (cursor >= end) break;
		}
		if (cursor < end) result.push({ start: cursor, end });
		return result;
	});
}
