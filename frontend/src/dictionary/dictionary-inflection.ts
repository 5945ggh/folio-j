import type { DictionaryMatch } from "./dictionary-api.ts";

type Part = NonNullable<DictionaryMatch["inflection"]>[number];
const forms: Record<NonNullable<Part["form"]>, string> = {
	irrealis: "未然形",
	continuative: "连用形",
	terminal: "终止形",
	attributive: "连体形",
	conditional: "假定形",
	imperative: "命令形",
};

/** Use actual source components; the headword already identifies the first component's base. */
export function dictionaryInflection(entry: DictionaryMatch): string {
	return (entry.inflection ?? [])
		.map((part, index) => {
			const detail = [
				index > 0 && part.dictionary_form !== part.surface
					? part.dictionary_form
					: null,
				part.form ? forms[part.form] : null,
				part.sound_change,
			].filter(Boolean);
			return `${part.surface}${detail.length ? `〔${detail.join("·")}〕` : ""}`;
		})
		.join("＋");
}
