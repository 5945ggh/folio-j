import type {
	DictionaryMatch,
	DictionarySourceAnalysis,
} from "./dictionary-api.ts";

export type DictionaryPage = Pick<
	DictionaryMatch,
	"start" | "end" | "surface"
> & {
	entries: DictionaryMatch[];
	analysis?: DictionarySourceAnalysis;
};

/** The service ranks sequence entries. Pagination combines only identical source coordinates. */
export function dictionaryPages(
	matches: DictionaryMatch[],
	analyses: DictionarySourceAnalysis[] = [],
): DictionaryPage[] {
	const pages = new Map<string, DictionaryPage>();
	for (const entry of matches) {
		const key = `${entry.start}:${entry.end}`;
		const page = pages.get(key);
		if (page) page.entries.push(entry);
		else
			pages.set(key, {
				start: entry.start,
				end: entry.end,
				surface: entry.surface,
				entries: [entry],
			});
	}
	for (const analysis of analyses) {
		const key = `${analysis.start}:${analysis.end}`;
		const page = pages.get(key);
		if (page) {
			page.analysis ??= analysis;
		} else if (!matches.length) {
			pages.set(key, {
				start: analysis.start,
				end: analysis.end,
				surface: analysis.surface,
				entries: [],
				analysis,
			});
		}
	}
	return [...pages.values()];
}
