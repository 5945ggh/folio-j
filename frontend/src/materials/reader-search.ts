import type { components } from "../api/schema";

export type RecordSearchItem =
	components["schemas"]["MaterialRecordSearchItem"];
export type RecordSearchKind = RecordSearchItem["kind"];
export type ReaderSearchKind = "original" | RecordSearchKind;
export type ReaderSearchState = {
	input: string;
	kind: "all" | ReaderSearchKind;
	chapterIds: string[] | null;
	filtersOpen: boolean;
	collapsed: Partial<Record<ReaderSearchKind, boolean>>;
	selectedKey: string | null;
};
export const initialReaderSearch = (): ReaderSearchState => ({
	input: "",
	kind: "all",
	chapterIds: null,
	filtersOpen: false,
	collapsed: {},
	selectedKey: null,
});
export const searchKinds = [
	"original",
	"segment",
	"translation",
	"bookmark",
] as const;
export const searchLabels = {
	original: "原文",
	segment: "片段",
	translation: "译文",
	bookmark: "书签",
};

/** null is every chapter; an empty selection must never become an unfiltered request. */
export function selectedSearchChapters(
	selection: readonly string[] | null,
	ids: readonly string[],
): string[] {
	return selection === null
		? [...ids]
		: ids.filter((id) => selection.includes(id));
}
export function toggleSearchChapter(
	selection: readonly string[] | null,
	ids: readonly string[],
	id: string,
): string[] | null {
	const current = selectedSearchChapters(selection, ids);
	const next = current.includes(id)
		? current.filter((value) => value !== id)
		: ids.filter((value) => value === id || current.includes(value));
	return next.length === ids.length ? null : next;
}

/** Highlight literal overlapping matches without interpreting regex or changing the text. */
export function searchTextParts(
	text: string,
	query: string,
): { text: string; matched: boolean; key: number }[] {
	if (!query) return [{ text, matched: false, key: 0 }];
	const ranges: { start: number; end: number }[] = [];
	let at = text.indexOf(query);
	while (at !== -1) {
		const last = ranges.at(-1);
		if (last && at <= last.end)
			last.end = Math.max(last.end, at + query.length);
		else ranges.push({ start: at, end: at + query.length });
		at = text.indexOf(query, at + 1);
	}
	const parts: { text: string; matched: boolean; key: number }[] = [];
	let cursor = 0;
	for (const range of ranges) {
		if (range.start > cursor)
			parts.push({
				text: text.slice(cursor, range.start),
				matched: false,
				key: cursor,
			});
		parts.push({
			text: text.slice(range.start, range.end),
			matched: true,
			key: range.start,
		});
		cursor = range.end;
	}
	if (cursor < text.length)
		parts.push({ text: text.slice(cursor), matched: false, key: cursor });
	return parts;
}
