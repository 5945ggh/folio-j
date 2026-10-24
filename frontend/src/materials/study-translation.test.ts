import assert from "node:assert/strict";
import test from "node:test";
import type { TranslationResult } from "../translation/api.ts";
import type { ChapterTranslation } from "./chapter-translations-query.ts";
import type { MaterialProvenance } from "./study-api.ts";
import {
	matchingStudyTranslation,
	translationReferenceKey,
} from "./study-translation.ts";

function reference(exact: string, start = 10): MaterialProvenance {
	return {
		contract_version: "1",
		material_id: "book",
		version_id: "v1",
		ranges: [
			{
				resource_id: "r",
				spine_index: 2,
				start,
				end: start + Array.from(exact).length,
				exact,
				text_sha256: "a".repeat(64),
				prefix: "",
				suffix: "",
			},
		],
	};
}

test("译文匹配只容忍原选区两端的 Unicode 空白，偏移采用码点", () => {
	const original = reference("\u0085\u3000𠮷が。\u00a0\n");
	const snapshot = structuredClone(original);
	assert.equal(
		translationReferenceKey(original),
		translationReferenceKey(reference("𠮷が。", 12)),
	);
	assert.deepEqual(original, snapshot);
	for (const text of [
		"\ufeff𠮷が。",
		"\u001c𠮷が。",
		"𠮷 が。",
		"𠮷が",
		"𠮷が。",
	]) {
		assert.notEqual(
			translationReferenceKey(original),
			translationReferenceKey(reference(text, 10)),
		);
	}
	assert.equal(translationReferenceKey(reference(" \n\u3000")), null);
});

test("相同文字在另一位置、材料、版本、spine 或摘要下不能套用译文", () => {
	const target = reference("同じ文。", 5);
	for (const other of [
		reference("同じ文。", 15),
		{ ...target, material_id: "other" },
		{ ...target, version_id: "v2" },
		{
			...target,
			ranges: target.ranges.map((range) => ({ ...range, spine_index: 3 })),
		},
		{
			...target,
			ranges: target.ranges.map((range) => ({
				...range,
				text_sha256: "b".repeat(64),
			})),
		},
	])
		assert.notEqual(
			translationReferenceKey(target),
			translationReferenceKey(other),
		);
});

test("边缘全空白范围可略去，相邻分段与完整范围保持同一匹配身份", () => {
	const padded = reference(" \t𠮷が。 ", 0);
	const range = padded.ranges[0];
	assert.ok(range);
	padded.ranges = [
		{ ...range, start: 0, end: 2, exact: " \t" },
		{ ...range, start: 2, end: 3, exact: "𠮷" },
		{ ...range, start: 3, end: 6, exact: "が。 " },
	];
	assert.equal(
		translationReferenceKey(padded),
		translationReferenceKey(reference("𠮷が。", 2)),
	);
	const invalid = reference("𠮷が。", 2);
	const invalidRange = invalid.ranges[0];
	assert.ok(invalidRange);
	invalidRange.end++;
	assert.equal(translationReferenceKey(invalid), null);
});

test("当前成功选择优先于最新结果；没有有效选择时按成功时间回退", () => {
	const target = reference("原文");
	const summary = (id: string, day: string, origin = target) =>
		({
			result_id: id,
			created_at: day,
			material_provenance: origin,
		}) as ChapterTranslation;
	const selected = (id: string, origin = target, deleted = false) =>
		({
			id,
			material_provenance: origin,
			material_deleted: deleted,
		}) as TranslationResult;
	const latest = [
		summary("older", "2026-10-23"),
		summary("latest", "2026-10-24"),
	];
	assert.equal(matchingStudyTranslation(target, latest, []), "latest");
	assert.equal(
		matchingStudyTranslation(target, latest, [selected("history")]),
		"history",
	);
	assert.equal(
		matchingStudyTranslation(target, latest, [
			selected("history"),
			selected("chosen"),
		]),
		"chosen",
	);
	assert.equal(
		matchingStudyTranslation(target, latest, [
			selected("wrong", reference("原文", 50)),
			selected("deleted", target, true),
		]),
		"latest",
	);
	assert.equal(matchingStudyTranslation(target, [], []), null);
});
