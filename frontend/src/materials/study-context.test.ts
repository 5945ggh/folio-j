import assert from "node:assert/strict";
import test from "node:test";
import type { components } from "../api/schema";
import type { Chapter } from "./api";
import cases from "./fixtures/c2-context-cases.json" with { type: "json" };
import {
	type ContextBudget,
	ContextPrefillError,
	prefillContext,
	splitContextSentences,
} from "./study-context.ts";

type Reference = components["schemas"]["MaterialProvenance"];
const defaults: ContextBudget = {
	enabled: true,
	before_sentences: 3,
	after_sentences: 3,
	before_characters: 200,
	after_characters: 200,
};

function resource(id: string, text: string): Chapter["resources"][number] {
	return {
		id,
		text,
		text_sha256: "a".repeat(64),
		href: `${id}.xhtml`,
		css: "",
		html_attributes: {},
		body_attributes: {},
	};
}

function chapter(text: string): Chapter {
	return {
		id: "chapter",
		material_id: "material",
		version_id: "version",
		title: "章",
		level: 0,
		resources: [resource("r", text)],
		parts: [
			{
				resource_id: "r",
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

function reference(
	book: Chapter,
	ranges: {
		resource_id: string;
		spine_index: number;
		start: number;
		end: number;
		exact?: string;
	}[],
): Reference {
	return {
		contract_version: "1",
		material_id: book.material_id,
		version_id: book.version_id,
		ranges: ranges.map((range) => {
			const text = book.resources.find((r) => r.id === range.resource_id);
			assert.ok(text);
			return {
				...range,
				exact:
					range.exact ??
					Array.from(text.text).slice(range.start, range.end).join(""),
				text_sha256: text.text_sha256,
				prefix: "",
				suffix: "",
			};
		}),
	};
}

function target(book: Chapter, start: number, end: number): Reference {
	return reference(book, [{ resource_id: "r", spine_index: 0, start, end }]);
}

for (const fixture of cases.sentences) {
	test(`fixed sentence fixture: ${fixture.id}`, () => {
		assert.deepEqual(splitContextSentences(fixture.text), fixture.expected);
	});
}

for (const fixture of cases.contexts) {
	test(`fixed context fixture: ${fixture.id}`, () => {
		const book = chapter(fixture.text);
		const selected = target(book, fixture.start, fixture.end);
		const original = structuredClone({
			book,
			selected,
			budget: fixture.budget,
		});
		assert.deepEqual(prefillContext(book, selected, fixture.budget), {
			before: fixture.before,
			after: fixture.after,
			beforeTruncated: fixture.before_truncated,
			afterTruncated: fixture.after_truncated,
		});
		assert.deepEqual({ book, selected, budget: fixture.budget }, original);
	});
}

for (const fixture of cases.chapter_cases) {
	test(`fixed chapter fixture: ${fixture.id}`, () => {
		const book = chapter("");
		book.resources = fixture.resources.map((r) => resource(r.id, r.text));
		book.parts = fixture.parts.map((part) => ({
			...part,
			html: "",
			leaf_start: 0,
			leaf_end: 1,
		}));
		const selected = reference(book, fixture.ranges);
		const original = structuredClone({ book, selected, defaults });
		assert.deepEqual(prefillContext(book, selected, defaults), {
			before: fixture.before,
			after: fixture.after,
			beforeTruncated: false,
			afterTruncated: false,
		});
		assert.deepEqual({ book, selected, defaults }, original);
	});
}

test("CRLF, leading whitespace and alternating closers retain their literal text", () => {
	assert.deepEqual(
		splitContextSentences(" \r\n「本当！？」!\r\n\r\n次\r\n末"),
		[" \r\n「本当！？」!\r\n\r\n", "次\r\n", "末"],
	);
});

test("disabled prefill is empty, while each budget is validated as an integer", () => {
	const book = chapter("前。学後。");
	const selected = target(book, 2, 3);
	assert.deepEqual(
		prefillContext(book, selected, { ...defaults, enabled: false }),
		{
			before: "",
			after: "",
			beforeTruncated: false,
			afterTruncated: false,
		},
	);
	for (const field of [
		"before_sentences",
		"after_sentences",
		"before_characters",
		"after_characters",
	] as const) {
		for (const value of [
			-1,
			0.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			100001,
		]) {
			assert.throws(
				() => prefillContext(book, selected, { ...defaults, [field]: value }),
				(error) =>
					error instanceof ContextPrefillError &&
					error.code === "invalid_budget",
			);
		}
	}
	assert.equal(
		prefillContext(book, selected, { ...defaults, before_characters: 100 })
			.before,
		"前。",
	);
});

test("part boundaries do not split a sentence or require DOM readiness", () => {
	const book = chapter("前。左残学右残。後。");
	const original = book.parts[0];
	assert.ok(original);
	book.parts = [
		{ ...original, start: 0, end: 3 },
		{ ...original, start: 3, end: 6 },
		{ ...original, start: 6, end: 10 },
	];
	assert.deepEqual(
		prefillContext(book, target(book, 4, 5), {
			...defaults,
			before_sentences: 1,
			after_sentences: 1,
		}),
		{
			before: "左残",
			after: "右残。",
			beforeTruncated: false,
			afterTruncated: false,
		},
	);
});

test("the two sides never borrow unused sentence or character budgets", () => {
	const book = chapter("甲。乙。丙。丁。学後。");
	assert.deepEqual(
		prefillContext(book, target(book, 8, 9), {
			...defaults,
			before_sentences: 2,
			after_sentences: 1,
			before_characters: 3,
			after_characters: 100,
		}),
		{
			before: "。丁。",
			after: "後。",
			beforeTruncated: true,
			afterTruncated: false,
		},
	);
});

test("NFC across resource seams changes context counts without moving the target", () => {
	const book = chapter("");
	book.resources = [resource("r1", "前。か"), resource("r2", "\u3099𠮷学後。")];
	const part = { html: "", leaf_start: 0, leaf_end: 1 };
	book.parts = [
		{ ...part, resource_id: "r1", spine_index: 0, start: 0, end: 3 },
		{ ...part, resource_id: "r2", spine_index: 1, start: 0, end: 5 },
	];
	const selected = reference(book, [
		{ resource_id: "r2", spine_index: 1, start: 2, end: 3 },
	]);
	const original = structuredClone({ book, selected, defaults });
	assert.deepEqual(
		prefillContext(book, selected, { ...defaults, before_characters: 2 }),
		{
			before: "が𠮷",
			after: "後。",
			beforeTruncated: false,
			afterTruncated: false,
		},
	);
	assert.deepEqual({ book, selected, defaults }, original);
	const combinedTarget = reference(book, [
		{ resource_id: "r1", spine_index: 0, start: 2, end: 3 },
		{ resource_id: "r2", spine_index: 1, start: 0, end: 2 },
	]);
	assert.deepEqual(prefillContext(book, combinedTarget, defaults), {
		before: "前。",
		after: "学後。",
		beforeTruncated: false,
		afterTruncated: false,
	});
	for (const range of [
		{ resource_id: "r1", spine_index: 0, start: 2, end: 3 },
		{ resource_id: "r2", spine_index: 1, start: 0, end: 2 },
	]) {
		assert.throws(
			() => prefillContext(book, reference(book, [range]), defaults),
			(error) =>
				error instanceof ContextPrefillError &&
				error.code === "unsafe_normalization",
		);
	}
});

test("invalid snapshots, stale identity, noncontinuous or out-of-chapter targets fail explicitly", () => {
	const book = chapter("前。学後。");
	const selected = target(book, 2, 3);
	const invalid: Reference[] = [
		{ ...selected, material_id: "other" },
		{ ...selected, version_id: "other" },
		{ ...selected, ranges: [] },
		...[
			{ exact: "別" },
			{ text_sha256: "b".repeat(64) },
			{ resource_id: "missing" },
			{ spine_index: 1 },
			{ start: 2.5 },
			{ end: 99 },
		].map((changes) => ({
			...selected,
			ranges: selected.ranges.map((range) => ({ ...range, ...changes })),
		})),
		target(book, 0, 1),
	];
	const partial = structuredClone(book);
	const first = partial.parts[0];
	assert.ok(first);
	partial.parts = [{ ...first, start: 1, end: 5 }];
	for (const candidate of invalid) {
		assert.throws(
			() => prefillContext(partial, candidate, defaults),
			(error) =>
				error instanceof ContextPrefillError &&
				error.code === "invalid_reference",
		);
	}
	for (const spans of [
		[
			{ start: 0, end: 1 },
			{ start: 2, end: 3 },
		],
		[
			{ start: 2, end: 3 },
			{ start: 0, end: 1 },
		],
		[
			{ start: 0, end: 3 },
			{ start: 2, end: 4 },
		],
	]) {
		assert.throws(
			() =>
				prefillContext(
					book,
					reference(
						book,
						spans.map((span) => ({
							resource_id: "r",
							spine_index: 0,
							...span,
						})),
					),
					defaults,
				),
			(error) =>
				error instanceof ContextPrefillError &&
				error.code === "invalid_reference",
		);
	}
});

test("missing, conflicting or invalid chapter parts fail without mutating inputs", () => {
	const book = chapter("前。学後。");
	const selected = target(book, 2, 3);
	const original = structuredClone({ book, selected, defaults });
	prefillContext(book, selected, defaults);
	assert.deepEqual({ book, selected, defaults }, original);
	const noResource = { ...book, resources: [] };
	const outsidePart = structuredClone(book);
	const first = outsidePart.parts[0];
	assert.ok(first);
	first.end = 99;
	const conflicting = {
		...book,
		resources: [...book.resources, resource("r", "別")],
	};
	for (const broken of [noResource, outsidePart, conflicting]) {
		assert.throws(
			() => prefillContext(broken, selected, defaults),
			(error) =>
				error instanceof ContextPrefillError &&
				error.code === "invalid_chapter",
		);
	}
});
