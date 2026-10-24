import assert from "node:assert/strict";
import test from "node:test";
import {
	completeChapterTranslations,
	inlineTranslationAtHit,
	recordsAtHit,
	sameRecordHit,
} from "./chapter-records.ts";
import type { MaterialProvenance } from "./study-api.ts";

function reference(
	start: number,
	end: number,
	spine_index = 0,
): MaterialProvenance {
	return {
		contract_version: "1",
		material_id: "book",
		version_id: "version",
		ranges: [
			{
				resource_id: "r",
				spine_index,
				start,
				end,
				exact: "原文",
				text_sha256: "hash",
				prefix: "",
				suffix: "",
			},
		],
	};
}
test("只有横排正文的单一翻译目标就地展开，学习片段与歧义目标保留浮卡", () => {
	const first = { identity_sha256: "t1", material_provenance: reference(3, 8) };
	const second = {
		identity_sha256: "t2",
		material_provenance: reference(6, 10),
	};
	const hit = { segmentIds: [], translationIds: ["t1"] };
	assert.equal(
		inlineTranslationAtHit([], [first], hit, "horizontal-tb"),
		first,
	);
	assert.equal(inlineTranslationAtHit([], [first], hit, "vertical-rl"), null);
	assert.equal(
		inlineTranslationAtHit(
			[],
			[first],
			{ ...hit, anchorPlacement: "margin-right" },
			"horizontal-tb",
		),
		null,
	);
	assert.equal(
		inlineTranslationAtHit(
			[],
			[first],
			{ ...hit, fixed: true },
			"horizontal-tb",
		),
		null,
	);
	assert.equal(
		inlineTranslationAtHit([], [first, second], hit, "horizontal-tb"),
		null,
	);
	assert.equal(
		inlineTranslationAtHit(
			[{ segment_id: "s", material_provenance: reference(0, 5) }],
			[first],
			hit,
			"horizontal-tb",
		),
		null,
	);
});
test("部分重叠从任一端进入都合并两类记录，相邻范围与别次spine不混入", () => {
	const segments = [{ segment_id: "s", material_provenance: reference(0, 5) }];
	const translations = [
		{ identity_sha256: "t1", material_provenance: reference(3, 8) },
		{ identity_sha256: "t2", material_provenance: reference(6, 10) },
		{ identity_sha256: "adjacent", material_provenance: reference(10, 12) },
		{ identity_sha256: "other-spine", material_provenance: reference(0, 5, 1) },
	];
	for (const hit of [
		{ segmentIds: ["s"] },
		{ segmentIds: [], translationIds: ["t2"] },
	]) {
		const selected = recordsAtHit(segments, translations, hit);
		assert.deepEqual(selected.segments, segments);
		assert.deepEqual(
			selected.translations.map((item) => item.identity_sha256),
			["t1", "t2"],
		);
	}
});
test("同名ID属于不同记录类型，本章入口保留完整正文顺序", () => {
	assert.equal(
		sameRecordHit(
			{ segmentIds: ["same"] },
			{ segmentIds: [], translationIds: ["same"] },
		),
		false,
	);
	assert.equal(
		sameRecordHit({ segmentIds: [] }, { segmentIds: [], translationIds: [] }),
		true,
	);
	const translations = [
		{ identity_sha256: "t", material_provenance: reference(20, 25) },
	];
	assert.deepEqual(
		recordsAtHit([], translations, { segmentIds: [], fixed: true })
			.translations,
		translations,
	);
	assert.deepEqual(recordsAtHit([], translations, null), {
		segments: [],
		translations: [],
	});
});
test("分页完成前不公布译文标记，重复出处只保留一项", () => {
	const first = { identity_sha256: "a", result_id: "old" },
		latest = { identity_sha256: "a", result_id: "new" };
	assert.deepEqual(
		completeChapterTranslations([{ items: [first], next_cursor: "more" }]),
		[],
	);
	assert.deepEqual(
		completeChapterTranslations([
			{ items: [first], next_cursor: "more" },
			{ items: [latest], next_cursor: null },
		]),
		[latest],
	);
});
