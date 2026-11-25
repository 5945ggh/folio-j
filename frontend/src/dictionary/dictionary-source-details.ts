import type { DictionarySourceAnalysis } from "./dictionary-api.ts";

export function dictionarySourceDetails(analysis: DictionarySourceAnalysis) {
	const head = analysis.components[0];
	const hasInflectionHead =
		!!head &&
		analysis.inflection[0]?.surface === head.surface &&
		analysis.inflection.map((part) => part.surface).join("") ===
			analysis.surface;
	const lexicalComponents = hasInflectionHead ? [head] : analysis.components;
	const forms = lexicalComponents
		.filter(
			(item) =>
				!item.is_oov &&
				item.dictionary_form &&
				item.dictionary_form !== item.surface,
		)
		.map((item) => item.dictionary_form);
	const conjugations = [
		...new Set(
			lexicalComponents
				.filter((item) => !item.is_oov && item.pos[4] && item.pos[4] !== "*")
				.map((item) => item.pos[4]?.replaceAll("-", "・")),
		),
	];
	const partsOfSpeech = [
		...new Set(
			lexicalComponents
				.filter((item) => !item.is_oov && item.pos[0] !== "補助記号")
				.flatMap(({ pos }) => {
					const [part, detail, subcategory] = pos;
					if (!part || part === "*") return [];
					if (
						detail === "固有名詞" &&
						subcategory &&
						subcategory !== "*" &&
						subcategory !== "一般"
					)
						return [`${detail}（${subcategory}）`];
					return [
						detail && !["一般", "普通名詞", "*"].includes(detail)
							? `${part}（${detail}）`
							: part,
					];
				}),
		),
	];
	const labels = [...partsOfSpeech, ...conjugations];
	const part = partsOfSpeech[0];
	const complete =
		analysis.components.at(-1)?.end === analysis.end &&
		analysis.components.map(({ surface }) => surface).join("") ===
			analysis.surface &&
		analysis.components.every(
			(component, index) =>
				!component.is_oov &&
				component.start ===
					(analysis.components[index - 1]?.end ?? analysis.start) &&
				component.end > component.start &&
				component.end - component.start ===
					Array.from(component.surface).length &&
				(!hasInflectionHead ||
					analysis.inflection[index]?.surface === component.surface),
		);
	const conjugation = conjugations[0]?.split("・")[0];
	let partOfSpeech: string | undefined;
	if (
		complete &&
		lexicalComponents.length === 1 &&
		part &&
		!["空白", "記号"].includes(head?.pos[0] ?? "")
	) {
		partOfSpeech =
			conjugation && conjugation !== part ? `${part}・${conjugation}` : part;
	}
	return { forms, labels, partOfSpeech };
}
