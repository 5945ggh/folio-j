import type { DictionaryMatch } from "./dictionary-api.ts";

export type DictionaryPage = Pick<
	DictionaryMatch,
	"start" | "end" | "surface"
> & {
	entries: DictionaryMatch[];
};

/** The service ranks sequence entries. Pagination combines only identical source coordinates. */
export function dictionaryPages(matches: DictionaryMatch[]): DictionaryPage[] {
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
	return [...pages.values()];
}
