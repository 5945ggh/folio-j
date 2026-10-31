import assert from "node:assert/strict";
import test from "node:test";
import {
	completeChapterTranslations,
	inlineTranslationAtHit,
	marginRecordEntry,
	recordsAtHit,
	sameMarginRecordHit,
	sameRecordHit,
} from "./chapter-records.ts";
import type { MaterialProvenance } from "./study-api.ts";
import { studyMarginEntries } from "./study-margin.ts";

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

test("页边初始页按实际入口身份选择，正文和本章入口保留原路由", () => {
	for (const anchorPlacement of [
		"margin-left",
		"margin-right",
		"margin-bottom",
	]) {
		for (const [ids, expected] of [
			[{ segmentIds: ["s"] }, { kind: "segment", id: "s" }],
			[
				{ segmentIds: [], translationIds: ["t"] },
				{ kind: "translation", id: "t" },
			],
			[{ segmentIds: ["s1", "s2", "s3"] }, { kind: "list", tab: "segment" }],
			[
				{ segmentIds: [], translationIds: ["t1", "t2", "t3"] },
				{ kind: "list", tab: "translation" },
			],
			[
				{ segmentIds: ["s"], translationIds: ["t"] },
				{ kind: "list", tab: "segment" },
			],
			[
				{ segmentIds: ["same"], translationIds: ["same"] },
				{ kind: "list", tab: "segment" },
			],
		] as const) {
			assert.deepEqual(
				marginRecordEntry({
					segmentIds: [...ids.segmentIds],
					...("translationIds" in ids
						? { translationIds: [...ids.translationIds] }
						: {}),
					anchorPlacement,
				}),
				expected,
			);
		}
	}
	for (const hit of [
		null,
		{ segmentIds: ["s"] },
		{ segmentIds: [], translationIds: ["t"], anchorPlacement: "text" },
		{ segmentIds: ["s"], fixed: true, anchorPlacement: "margin-right" },
		{ segmentIds: [], anchorPlacement: "margin-right" },
	])
		assert.equal(marginRecordEntry(hit), undefined);
});

test("页边再次点击仅关闭同一页边入口，正文同身份命中仍切换为页边直达", () => {
	for (const entry of [
		{ segmentIds: ["s"] },
		{ segmentIds: [], translationIds: ["t"] },
		{ segmentIds: ["s1", "s2"], translationIds: ["t"] },
	]) {
		for (const anchorPlacement of [undefined, "text"])
			assert.equal(
				sameMarginRecordHit({ ...entry, anchorPlacement }, entry),
				false,
			);
		for (const anchorPlacement of [
			"margin-left",
			"margin-right",
			"margin-bottom",
		])
			assert.equal(
				sameMarginRecordHit({ ...entry, anchorPlacement }, entry),
				true,
			);
		assert.equal(
			sameMarginRecordHit(
				{ ...entry, anchorPlacement: "margin-right", fixed: true },
				entry,
			),
			false,
		);
		assert.equal(
			sameMarginRecordHit(
				{ ...entry, anchorPlacement: "margin-right" },
				{ segmentIds: ["other"] },
			),
			false,
		);
	}
});

test("页边数字聚合和独立译文入口保留各自意图，同时可找回完整相连记录", () => {
	const segments = [
		{ segment_id: "s1", material_provenance: reference(0, 5) },
		{ segment_id: "s2", material_provenance: reference(3, 8) },
		{ segment_id: "s3", material_provenance: reference(6, 10) },
	];
	const translations = [
		{ identity_sha256: "t", material_provenance: reference(9, 12) },
	];
	const entries = studyMarginEntries(
		[
			...segments.map((item, index) => ({
				id: item.segment_id,
				rects: [{ left: 120, right: 190, top: 100 + index * 10, bottom: 140 }],
			})),
			{
				id: "t",
				kind: "translation",
				rects: [{ left: 120, right: 190, top: 180, bottom: 200 }],
			},
		],
		{ left: 100, right: 700, top: 80, bottom: 600 },
		{ width: 1000, height: 800 },
		false,
		{ left: 100, right: 700, top: 0, bottom: 800 },
	);
	assert.equal(entries.length, 2);
	const hits = entries.map((entry) => ({
		...entry,
		anchorPlacement: "margin-right",
	}));
	assert.deepEqual(hits.map(marginRecordEntry), [
		{ kind: "list", tab: "segment" },
		{ kind: "translation", id: "t" },
	]);
	for (const hit of hits)
		assert.deepEqual(recordsAtHit(segments, translations, hit), {
			segments,
			translations,
		});
	assert.deepEqual(
		entries.map((entry) => entry.segmentIds),
		[["s1", "s2", "s3"], []],
	);
});

test("单片段与单译文页边入口不被重叠组中其他同类或异类记录改写", () => {
	const segments = ["s1", "s2"].map((segment_id) => ({
		segment_id,
		material_provenance: reference(0, 10),
	}));
	const translations = ["t1", "t2"].map((identity_sha256) => ({
		identity_sha256,
		material_provenance: reference(0, 10),
	}));
	for (const [ids, expected] of [
		[{ segmentIds: ["s2"] }, { kind: "segment", id: "s2" }],
		[
			{ segmentIds: [], translationIds: ["t2"] },
			{ kind: "translation", id: "t2" },
		],
	] as const) {
		const hit = {
			segmentIds: [...ids.segmentIds],
			...("translationIds" in ids
				? { translationIds: [...ids.translationIds] }
				: {}),
			anchorPlacement: "margin-right",
		};
		assert.deepEqual(marginRecordEntry(hit), expected);
		assert.deepEqual(recordsAtHit(segments, translations, hit), {
			segments,
			translations,
		});
	}
});
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
