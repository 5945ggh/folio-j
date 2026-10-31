import type { VocabularyQuery } from "./vocabulary-api";

export const VOCABULARY_PAGE_SIZE = 40;
export const OCCURRENCE_PAGE_SIZE = 10;

export type VocabularyState = {
	q: string;
	pos: string;
	sort: NonNullable<VocabularyQuery["sort"]>;
	page: number;
	word: string;
	occurrencePage: number;
};

function pageNumber(value: string | null): number {
	if (!value || !/^[1-9]\d{0,5}$/.test(value)) return 1;
	return Number(value);
}

export function readVocabularyState(search: string): VocabularyState {
	const params = new URLSearchParams(search);
	return {
		q: [...(params.get("q") ?? "")].slice(0, 160).join(""),
		pos: params.get("pos") ?? "",
		sort:
			params.get("sort") === "frequency_asc"
				? "frequency_asc"
				: "frequency_desc",
		page: pageNumber(params.get("page")),
		word: params.get("word") ?? "",
		occurrencePage: pageNumber(params.get("occurrencePage")),
	};
}

export function updateVocabularyState(
	current: VocabularyState,
	patch: Partial<VocabularyState>,
): string {
	const filtering =
		patch.q !== undefined ||
		patch.pos !== undefined ||
		patch.sort !== undefined;
	const next = {
		...current,
		...(filtering ? { page: 1, word: "", occurrencePage: 1 } : {}),
		...patch,
	};
	if (patch.word !== undefined) next.occurrencePage = 1;
	if (patch.page !== undefined) {
		next.word = "";
		next.occurrencePage = 1;
	}
	const params = new URLSearchParams();
	if (next.q.trim()) params.set("q", next.q.trim());
	if (next.pos) params.set("pos", next.pos);
	if (next.sort !== "frequency_desc") params.set("sort", next.sort);
	if (next.page > 1) params.set("page", String(next.page));
	if (next.word) {
		params.set("word", next.word);
		if (next.occurrencePage > 1)
			params.set("occurrencePage", String(next.occurrencePage));
	}
	const value = params.toString();
	return value ? `?${value}` : "";
}
