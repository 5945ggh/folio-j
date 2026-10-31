import assert from "node:assert/strict";
import test from "node:test";
import type { components } from "../api/schema";
import type { Chapter } from "./api.ts";
import {
	readVocabularyReaderTarget,
	validateVocabularyReaderTarget,
	vocabularyReaderHref,
	vocabularyReaderPosition,
} from "./vocabulary-navigation.ts";

const item: components["schemas"]["MaterialVocabularyOccurrence"] = {
	resource_id: "r",
	start: 1,
	end: 3,
	match: "𠮷野",
	text_sha256: "snapshot",
	chapter_id: "chapter",
	chapter_title: "章",
	part_index: 0,
	spine_index: 2,
	before: "甲",
	after: "乙",
	reading: "ヨシノ",
	parts_of_speech: [],
	is_oov: false,
};
const chapter: Chapter = {
	id: "chapter",
	material_id: "book",
	version_id: "version",
	title: "章",
	level: 1,
	parts: [
		{
			resource_id: "r",
			spine_index: 2,
			start: 0,
			end: 4,
			leaf_start: 0,
			leaf_end: 1,
			html: "<p>甲𠮷野乙</p>",
		},
	],
	resources: [
		{
			id: "r",
			text: "甲𠮷野乙",
			text_sha256: "snapshot",
			body_attributes: {},
			html_attributes: {},
			css: "",
			href: "chapter.xhtml",
		},
	],
};
const book = { id: "book", version_id: "version" };
function target() {
	const href = vocabularyReaderHref("book", "version", item);
	assert.ok(href);
	const parsed = readVocabularyReaderTarget(
		new URL(href, "https://folio.invalid").search,
	);
	assert.ok(parsed);
	return parsed;
}
test("temporary vocabulary links round trip exact codepoint reference on refresh", () => {
	const parsed = target();
	assert.equal(parsed.exact, "𠮷野");
	assert.equal(parsed.spine_index, 2);
	validateVocabularyReaderTarget(parsed, book, chapter);
	const settings = {
		font_size: 26,
		line_height: 2.2,
		writing_mode: "vertical-rl" as const,
	};
	assert.deepEqual(vocabularyReaderPosition(parsed, settings), {
		version_id: "version",
		chapter_id: "chapter",
		part_index: 0,
		resource_id: "r",
		kind: "text",
		offset: 1,
		at_chapter_end: false,
		settings,
	});
	assert.equal(readVocabularyReaderTarget("?ordinary=1"), null);
});
test("unmapped vocabulary occurrences do not create approximate links", () => {
	for (const patch of [
		{ chapter_id: null },
		{ part_index: null },
		{ spine_index: null },
		{ start: -1 },
		{ end: 8 },
		{ text_sha256: "" },
	])
		assert.equal(
			vocabularyReaderHref("book", "version", { ...item, ...patch }),
			null,
		);
});
test("present but malformed or ambiguous targets fail instead of resuming", () => {
	const href = vocabularyReaderHref("book", "version", item);
	assert.ok(href);
	const search = new URL(href, "https://folio.invalid").search;
	for (const query of [
		"?vocabulary=",
		"?vocabulary=null",
		"?vocabulary={bad",
		`${search}&vocabulary=null`,
		`${search}&segment=saved`,
		`?vocabulary=${encodeURIComponent(JSON.stringify({ ...target(), start: 1.5 }))}`,
	])
		assert.throws(() => readVocabularyReaderTarget(query), /无法校验/);
});
test("changed material, version, resource, spine, ranges and exact snapshot fail closed", () => {
	for (const patch of [
		{ material_id: "other" },
		{ version_id: "other" },
		{ chapter_id: "other" },
		{ resource_id: "other" },
		{ spine_index: 1 },
		{ part_index: 1 },
		{ start: 4, end: 6 },
		{ end: 6 },
		{ exact: "吉野" },
		{ text_sha256: "other" },
	])
		assert.throws(
			() =>
				validateVocabularyReaderTarget(
					{ ...target(), ...patch },
					book,
					chapter,
				),
			/无法校验/,
		);
	assert.throws(() =>
		validateVocabularyReaderTarget(target(), book, {
			...chapter,
			material_id: "other",
		}),
	);
	assert.throws(() =>
		validateVocabularyReaderTarget(target(), book, {
			...chapter,
			version_id: "other",
		}),
	);
});
test("same resource reused in another spine cannot satisfy the target", () => {
	assert.throws(() =>
		validateVocabularyReaderTarget(target(), book, {
			...chapter,
			parts: chapter.parts.map((part) => ({ ...part, spine_index: 9 })),
		}),
	);
});
