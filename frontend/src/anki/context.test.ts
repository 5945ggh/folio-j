import assert from "node:assert/strict";
import { it } from "node:test";
import type { Chapter } from "../materials/api.ts";
import type { MaterialProvenance } from "../materials/study-api.ts";
import { expandedSentenceSource } from "./context.ts";

function chapterOf(...texts: string[]): Chapter {
	const resources = texts.map((text, index) => ({
		id: `res-${index}`,
		href: `part-${index}.xhtml`,
		text,
		text_sha256: `sha-${index}`,
		css: "",
		html_attributes: {},
		body_attributes: {},
	}));
	return {
		id: "chapter",
		material_id: "book",
		version_id: "version",
		title: "第一章",
		level: 0,
		resources,
		parts: resources.map((resource, index) => ({
			resource_id: resource.id,
			spine_index: index,
			start: 0,
			end: Array.from(resource.text).length,
			leaf_start: 0,
			leaf_end: 1,
			html: `<p>${resource.text}</p>`,
		})),
	};
}

function provenance(
	chapter: Chapter,
	...coordinates: [partIndex: number, start: number, end: number][]
): MaterialProvenance {
	return {
		contract_version: "1",
		material_id: chapter.material_id,
		version_id: chapter.version_id,
		ranges: coordinates.map(([index, start, end]) => {
			const resource = chapter.resources[index];
			assert.ok(resource);
			return {
				resource_id: resource.id,
				spine_index: index,
				start,
				end,
				text_sha256: resource.text_sha256,
				exact: Array.from(resource.text).slice(start, end).join(""),
				prefix: "",
				suffix: "",
			};
		}),
	};
}

it("keeps the selected repeated word at its NFC code-point location after a part seam", () => {
	const chapter = chapterOf("　𠮷か", "\u3099猫と猫を見る。");
	const source = expandedSentenceSource(
		chapter,
		provenance(chapter, [1, 3, 4]),
		"猫",
	);
	assert.equal(source?.sentence, "𠮷が猫と猫を見る。");
	assert.deepEqual(source?.focus, { start: 4, end: 5, text: "猫" });
});

it("translates a focus spanning parts and crops surrounding whitespace", () => {
	const chapter = chapterOf("　𠮷　か", "\u3099猫　を見る。");
	const reference = provenance(chapter, [0, 2, 4], [1, 0, 3]);
	const source = expandedSentenceSource(chapter, reference, "　が猫　");
	assert.equal(source?.sentence, "𠮷　が猫　を見る。");
	assert.deepEqual(source?.focus, { start: 2, end: 4, text: "が猫" });
	assert.equal(
		expandedSentenceSource(chapter, provenance(chapter, [0, 3, 4]), "か"),
		null,
		"a focus ending inside the NFC combination is unsafe",
	);
});

it("uses normalized LF coordinates for a selection spanning two sentences", () => {
	const chapter = chapterOf("一昨日。 \r\n　𠮷昨日。");
	const source = expandedSentenceSource(
		chapter,
		provenance(chapter, [0, 2, 9]),
		"日。 \n　𠮷",
	);
	assert.equal(source?.sentence, "一昨日。 \n　𠮷昨日。");
	assert.deepEqual(source?.focus, { start: 2, end: 8, text: "日。 \n　𠮷" });
});

it("omits focus when the reader gives no precise target, selects the full sentence, or presents another surface", () => {
	const chapter = chapterOf("　猫が歩く。 ");
	const whole = provenance(chapter, [0, 0, 7]);
	const word = provenance(chapter, [0, 1, 2]);
	assert.equal(expandedSentenceSource(chapter, word)?.focus, undefined);
	assert.equal(
		expandedSentenceSource(chapter, whole, "猫が歩く。")?.focus,
		undefined,
	);
	assert.equal(expandedSentenceSource(chapter, word, "歩く")?.focus, undefined);
});
