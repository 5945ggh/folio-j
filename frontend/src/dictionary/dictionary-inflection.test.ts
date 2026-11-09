import assert from "node:assert/strict";
import test from "node:test";
import type { DictionaryMatch } from "./dictionary-api.ts";
import { dictionaryInflection } from "./dictionary-inflection.ts";

const entry: DictionaryMatch = {
	id: "one",
	dictionary_id: "one",
	term: "空く",
	reading: "あく",
	start: 0,
	end: 6,
	surface: "空いていない",
	definitions: [],
};

test("活用说明保留实际接续，六形用中文、音便保留日文术语", () => {
	assert.equal(
		dictionaryInflection({
			...entry,
			inflection: [
				{
					surface: "空い",
					dictionary_form: "空く",
					form: "continuative",
					sound_change: "イ音便",
				},
				{ surface: "て", dictionary_form: "て" },
				{ surface: "い", dictionary_form: "いる", form: "irrealis" },
				{ surface: "ない", dictionary_form: "ない" },
			],
		}),
		"空い〔连用形·イ音便〕＋て＋い〔いる·未然形〕＋ない",
	);
});

test("没有形态证据时留白，同一原文的各词条分别使用自己的证据", () => {
	assert.equal(dictionaryInflection(entry), "");
	const restored: DictionaryMatch = {
		...entry,
		inflection: [
			{ surface: "食べ", dictionary_form: "食べる", form: "irrealis" },
			{ surface: "られ", dictionary_form: "られる", form: "irrealis" },
		],
	};
	assert.equal(
		dictionaryInflection(restored),
		"食べ〔未然形〕＋られ〔られる·未然形〕",
	);
	assert.equal(dictionaryInflection({ ...restored, inflection: [] }), "");
});
