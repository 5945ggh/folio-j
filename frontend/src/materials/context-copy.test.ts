import assert from "node:assert/strict";
import test from "node:test";
import type { Chapter } from "./api.ts";
import {
	buildContextCopy,
	type ContextCopyPreferences,
	DEFAULT_CONTEXT_COPY,
} from "./context-copy.ts";
import type { MaterialProvenance } from "./study-api.ts";
import { ContextPrefillError } from "./study-context.ts";

function chapter(text: string): Chapter {
	return {
		id: "chapter",
		material_id: "material",
		version_id: "version",
		title: "第一章",
		level: 0,
		resources: [
			{
				id: "resource",
				text,
				text_sha256: "a".repeat(64),
				href: "resource.xhtml",
				css: "",
				html_attributes: {},
				body_attributes: {},
			},
		],
		parts: [
			{
				resource_id: "resource",
				spine_index: 0,
				start: 0,
				end: Array.from(text).length,
				html: "",
				leaf_start: 0,
				leaf_end: 1,
			},
		],
	};
}

function target(book: Chapter, start: number, end: number): MaterialProvenance {
	const resource = book.resources[0];
	assert.ok(resource);
	return {
		contract_version: "1",
		material_id: book.material_id,
		version_id: book.version_id,
		ranges: [
			{
				resource_id: resource.id,
				spine_index: 0,
				start,
				end,
				exact: Array.from(resource.text).slice(start, end).join(""),
				text_sha256: resource.text_sha256,
				prefix: "不复制的前缀",
				suffix: "不复制的后缀",
			},
		],
	};
}

const budgetFields = [
	"before_sentences",
	"after_sentences",
	"before_characters",
	"after_characters",
] as const;

test("copy labels separate exact target, local context, and optional source", () => {
	const book = chapter("前々。前。 𠮷が\n学ぶ \n後。遠後。");
	const selected = target(book, 5, 13);
	assert.equal(selected.ranges[0]?.exact, " 𠮷が\n学ぶ \n");
	assert.deepEqual(
		buildContextCopy(book, selected, DEFAULT_CONTEXT_COPY, " 本 "),
		{
			text: "出处：《本》／第一章\n\n目标原文：\n 𠮷が\n学ぶ \n\n\n前文：\n前々。前。\n\n后文：\n後。遠後。",
			beforeTruncated: false,
			afterTruncated: false,
		},
	);
	assert.equal(
		buildContextCopy(
			book,
			selected,
			{
				...DEFAULT_CONTEXT_COPY,
				include_source: false,
				before_sentences: 0,
				after_sentences: 0,
			},
			"本",
		).text,
		"目标原文：\n 𠮷が\n学ぶ \n",
	);
	for (const [title, chapterTitle, source] of [
		["《本》", " 第一章 ", "出处：《本》／第一章"],
		["", "第一章", "出处：第一章"],
		["本", "", "出处：《本》"],
		[" ", " ", ""],
	]) {
		assert.equal(
			buildContextCopy(
				{ ...book, title: chapterTitle ?? "" },
				selected,
				{ ...DEFAULT_CONTEXT_COPY, before_sentences: 0, after_sentences: 0 },
				title ?? "",
			).text,
			`${source ? `${source}\n\n` : ""}目标原文：\n 𠮷が\n学ぶ \n`,
		);
	}
});

test("independent sentence and codepoint budgets annotate cuts outside original text", () => {
	const book = chapter("甲。乙。𠮷丙。学ぶ。後𠮷。遠。");
	const selected = target(book, 7, 10);
	const preferences = {
		...DEFAULT_CONTEXT_COPY,
		before_sentences: 2,
		before_characters: 4,
		after_sentences: 2,
		after_characters: 2,
		include_source: false,
	};
	assert.deepEqual(buildContextCopy(book, selected, preferences, "本"), {
		text: "目标原文：\n学ぶ。\n\n前文（已截断）：\n。𠮷丙。\n\n后文（已截断）：\n後𠮷",
		beforeTruncated: true,
		afterTruncated: true,
	});
	const whole = buildContextCopy(
		book,
		selected,
		{
			...preferences,
			before_sentences: 1,
			before_characters: 100,
			after_sentences: 1,
			after_characters: 100,
		},
		"本",
	);
	assert.deepEqual(whole, {
		text: "目标原文：\n学ぶ。\n\n前文：\n𠮷丙。\n\n后文：\n後𠮷。",
		beforeTruncated: false,
		afterTruncated: false,
	});
	for (const field of budgetFields) {
		const copy = buildContextCopy(
			book,
			selected,
			{ ...preferences, [field]: 0 },
			"本",
		);
		assert.equal(
			copy.text.includes(field.startsWith("before") ? "前文" : "后文"),
			false,
		);
	}
});

test("chapter edges and whitespace-only sides omit empty context blocks", () => {
	const preferences = { ...DEFAULT_CONTEXT_COPY, after_sentences: 3 };
	for (const [text, start, end] of [
		["学", 0, 1],
		[" \n学\n ", 2, 3],
	] as const) {
		const book = chapter(text);
		assert.deepEqual(
			buildContextCopy(book, target(book, start, end), preferences, "本"),
			{
				text: "出处：《本》／第一章\n\n目标原文：\n学",
				beforeTruncated: false,
				afterTruncated: false,
			},
		);
	}
});

test("copy verifies reference identity even with all context budgets disabled", () => {
	const book = chapter("前。𠮷学後。");
	const selected = target(book, 2, 4);
	const preferences: ContextCopyPreferences = {
		before_sentences: 0,
		before_characters: 0,
		after_sentences: 0,
		after_characters: 0,
		include_source: false,
	};
	assert.equal(
		buildContextCopy(book, selected, preferences, "本").text,
		"目标原文：\n𠮷学",
	);
	const range = selected.ranges[0];
	assert.ok(range);
	for (const invalid of [
		{ ...selected, version_id: "stale" },
		{ ...selected, ranges: [{ ...range, text_sha256: "stale" }] },
		{ ...selected, ranges: [{ ...range, exact: "別" }] },
		{ ...selected, ranges: [{ ...range, start: 2.5 }] },
		{
			...selected,
			ranges: [
				{ ...range, end: 3, exact: "𠮷" },
				{ ...range, start: 4, end: 5, exact: "後" },
			],
		},
	]) {
		assert.throws(
			() => buildContextCopy(book, invalid, preferences, "本"),
			(error) =>
				error instanceof ContextPrefillError &&
				error.code === "invalid_reference",
		);
	}
});

test("multi-resource targets normalize the verified exact text and leave all input data untouched", () => {
	const book = chapter("前。か");
	const first = book.resources[0];
	const part = book.parts[0];
	assert.ok(first && part);
	book.resources.push({
		...first,
		id: "next",
		text: "\u3099𠮷学。",
		text_sha256: "b".repeat(64),
	});
	book.parts.push({
		...part,
		resource_id: "next",
		spine_index: 1,
		start: 0,
		end: 4,
	});
	const selected = target(book, 2, 3);
	const firstRange = selected.ranges[0];
	assert.ok(firstRange);
	selected.ranges.push({
		...firstRange,
		resource_id: "next",
		spine_index: 1,
		start: 0,
		end: 2,
		exact: "\u3099𠮷",
		text_sha256: "b".repeat(64),
	});
	const preferences = { ...DEFAULT_CONTEXT_COPY, after_sentences: 1 };
	const original = structuredClone({ book, selected, preferences });
	function freeze(value: object) {
		Object.freeze(value);
		for (const child of Object.values(value))
			if (child && typeof child === "object") freeze(child);
	}
	freeze(book);
	freeze(selected);
	freeze(preferences);
	assert.deepEqual(buildContextCopy(book, selected, preferences, "本"), {
		text: "出处：《本》／第一章\n\n目标原文：\nが𠮷\n\n前文：\n前。\n\n后文：\n学。",
		beforeTruncated: false,
		afterTruncated: false,
	});
	assert.deepEqual({ book, selected, preferences }, original);
});
