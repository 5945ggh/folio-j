import assert from "node:assert/strict";
import { it } from "node:test";
import type { DictionarySourceAnalysis } from "./dictionary-api.ts";
import { dictionarySourceDetails } from "./dictionary-source-details.ts";

const walking: DictionarySourceAnalysis = {
	start: 1,
	end: 4,
	surface: "歩いた",
	reading: "アルイタ",
	components: [
		{
			start: 1,
			end: 3,
			surface: "歩い",
			reading: "アルイ",
			dictionary_form: "歩く",
			pos: ["動詞", "一般", "*", "*", "五段-カ行", "連用形-イ音便"],
			is_oov: false,
		},
		{
			start: 3,
			end: 4,
			surface: "た",
			reading: "タ",
			dictionary_form: "た",
			pos: ["助動詞", "*", "*", "*", "助動詞-タ", "終止形-一般"],
			is_oov: false,
		},
	],
	inflection: [
		{ surface: "歩い", dictionary_form: "歩く", form: "continuative" },
		{ surface: "た", dictionary_form: "た", form: "terminal" },
	],
};

it("uses the source word's part of speech and conjugation, omitting the auxiliary", () => {
	assert.deepEqual(dictionarySourceDetails(walking), {
		forms: ["歩く"],
		labels: ["動詞", "五段・カ行"],
		partOfSpeech: "動詞・五段",
	});
});

it("does not prefill a multi-component target without a fully verified inflection chain", () => {
	assert.equal(
		dictionarySourceDetails({ ...walking, inflection: [] }).partOfSpeech,
		undefined,
	);
	const cut = {
		...walking,
		components: walking.components.map((component, index) =>
			index === 0 ? { ...component, start: 2 } : component,
		),
	};
	assert.equal(dictionarySourceDetails(cut).partOfSpeech, undefined);
});

it("prefills a known single word but leaves out-of-vocabulary evidence empty", () => {
	const cat: DictionarySourceAnalysis = {
		start: 7,
		end: 8,
		surface: "猫",
		reading: "ネコ",
		components: [
			{
				start: 7,
				end: 8,
				surface: "猫",
				reading: "ネコ",
				dictionary_form: "猫",
				pos: ["名詞", "普通名詞", "一般", "*", "*", "*"],
				is_oov: false,
			},
		],
		inflection: [],
	};
	assert.equal(dictionarySourceDetails(cat).partOfSpeech, "名詞");
	assert.equal(
		dictionarySourceDetails({
			...cat,
			components: cat.components.map((component) => ({
				...component,
				is_oov: true,
			})),
		}).partOfSpeech,
		undefined,
	);
});
