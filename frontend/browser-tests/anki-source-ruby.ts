import { expandedSentenceSource } from "../src/anki/context";
import { originalSentenceRuby } from "../src/anki/sentence-ruby";
import type { components } from "../src/api/schema";
import type { BrowserHarness } from "./harness";

export function checkAnkiRubyCoordinates(check: BrowserHarness["check"]) {
	const repeated = "𠮷 野で食べる。";
	const text = repeated + repeated;
	const points = Array.from(repeated);
	const split = 4;
	const hash = "a".repeat(64);
	const chapter: components["schemas"]["MaterialChapterResponse"] = {
		id: "chapter",
		material_id: "book",
		version_id: "version",
		title: "chapter",
		level: 0,
		resources: [
			{
				id: "r",
				text,
				text_sha256: hash,
				href: "chapter.xhtml",
				css: "",
				html_attributes: {},
				body_attributes: {},
			},
		],
		parts: [
			{
				resource_id: "r",
				spine_index: 0,
				start: 0,
				end: points.length,
				leaf_start: 0,
				leaf_end: 1,
				html: `<ruby><span data-locator-leaf="0">${repeated}</span><rt>別の箇所</rt></ruby>`,
			},
			{
				resource_id: "r",
				spine_index: 0,
				start: points.length,
				end: points.length + split,
				leaf_start: 1,
				leaf_end: 5,
				html: '<ruby><rb><span data-locator-leaf="1">𠮷</span></rb><span data-locator-leaf="2"> </span><rb><span data-locator-leaf="3">野</span></rb><rt>よし</rt><rt>の</rt></ruby><span data-locator-leaf="4">で</span>',
			},
			{
				resource_id: "r",
				spine_index: 0,
				start: points.length + split,
				end: points.length * 2,
				leaf_start: 5,
				leaf_end: 6,
				html: '<span data-locator-leaf="5">食べる。</span>',
			},
		],
	};
	const source = expandedSentenceSource(chapter, {
		contract_version: "1",
		material_id: chapter.material_id,
		version_id: chapter.version_id,
		ranges: [
			{
				resource_id: "r",
				spine_index: 0,
				start: points.length + split,
				end: points.length + split + 3,
				exact: "食べる",
				text_sha256: hash,
				prefix: "",
				suffix: "",
			},
		],
	});
	check(source?.sentence === repeated, "例句可跨 part，保留原文及非 BMP 汉字");

	const generation = "generation";
	const readings: components["schemas"]["MaterialReadingsResponse"] = {
		material_id: chapter.material_id,
		version_id: chapter.version_id,
		generation_id: generation,
		resources: [
			{
				resource_id: "r",
				text_sha256: hash,
				tokens: [
					{
						start: points.length + split,
						end: points.length + split + 3,
						surface: "食べる",
						reading: "タベル",
						dictionary_form: "食べる",
						normalized_form: "食べる",
						is_oov: false,
						pos: ["動詞"],
					},
				],
			},
		],
	};
	const actual = originalSentenceRuby(source, readings, generation, document);
	const expected = [
		{ start: 0, end: 1, reading: "よし" },
		{ start: 2, end: 3, reading: "の" },
		{ start: 4, end: 5, reading: "た" },
	];
	check(
		JSON.stringify(actual) === JSON.stringify(expected),
		"以原文码点绑定当前出处，跨 part 保留显式作者分组且自动注音排除送假名",
	);
	const stale = originalSentenceRuby(
		source,
		{ ...readings, generation_id: "old" },
		generation,
		document,
	);
	check(
		JSON.stringify(stale) === JSON.stringify(expected.slice(0, 2)),
		"旧代次不得覆盖原文读音",
	);
}
