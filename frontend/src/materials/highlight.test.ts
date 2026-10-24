import assert from "node:assert/strict";
import test from "node:test";
import type { Projection } from "./dom.ts";
import { clearSearchHighlights, highlightRange } from "./highlight.ts";

function harness(supported = true) {
	class TestRange {
		start: [unknown, number] | null = null;
		end: [unknown, number] | null = null;
		get startContainer() {
			return this.start?.[0];
		}
		get endContainer() {
			return this.end?.[0];
		}
		get startOffset() {
			return this.start?.[1];
		}
		get endOffset() {
			return this.end?.[1];
		}
		setStart(node: unknown, offset: number) {
			this.start = [node, offset];
		}
		setEnd(node: unknown, offset: number) {
			this.end = [node, offset];
		}
	}
	const style = { textContent: "" };
	class Highlight {
		ranges: TestRange[];
		constructor(...ranges: TestRange[]) {
			this.ranges = ranges;
		}
	}
	const marks = new Map<string, Highlight>();
	const doc = {
		createRange: () => new TestRange(),
		getElementById: () => style,
		defaultView: supported ? { Highlight, CSS: { highlights: marks } } : {},
	};
	return {
		doc: doc as unknown as Document,
		marks,
		style,
		paintedRanges: (name = "folio-search") =>
			marks.get(name)?.ranges.map(({ start, end }) => ({ start, end })),
	};
}
function projection(chunks: string[]): Projection {
	let offset = 0;
	return {
		raw: chunks.join(""),
		entries: chunks.map((data) => {
			const start = offset;
			offset += data.length;
			return {
				node: { data, length: data.length } as Text,
				start,
				end: offset,
			};
		}),
	};
}

test("Unicode search offsets highlight exact repeated occurrence across existing leaves", () => {
	const p = projection(["𠮷あ", "いう𠮷", "あいう"]);
	const h = harness();
	highlightRange(h.doc, p, 4, 8);
	assert.deepEqual(h.paintedRanges(), [
		{ start: [p.entries[1]?.node, 2], end: [p.entries[2]?.node, 3] },
	]);
	assert.equal(h.marks.size, 1);
	assert.ok(h.marks.has("folio-search"));
	assert.deepEqual(
		p.entries.map((e) => e.node.data),
		["𠮷あ", "いう𠮷", "あいう"],
	);
});
test("NFC range boundaries project decomposed source text without changing original nodes", () => {
	const p = projection(["か", "\u3099く", "せい"]);
	const h = harness();
	highlightRange(h.doc, p, 0, 2);
	assert.deepEqual(h.paintedRanges(), [
		{ start: [p.entries[0]?.node, 0], end: [p.entries[1]?.node, 2] },
	]);
	assert.equal(p.raw, "か\u3099くせい");
});
test("clearing navigation feedback is idempotent and preserves all persistent record marks", () => {
	const h = harness();
	highlightRange(h.doc, projection(["原文"]), 0, 2);
	const persistent = [
		"folio-study",
		"folio-study-active",
		"folio-translation",
		"folio-translation-active",
	];
	const feedback = h.marks.get("folio-search");
	assert.ok(feedback);
	for (const name of persistent) h.marks.set(name, feedback);
	let removed = 0;
	Object.assign(h.style, { remove: () => removed++ });
	clearSearchHighlights(h.doc);
	clearSearchHighlights(h.doc);
	assert.equal(h.marks.has("folio-search"), false);
	assert.deepEqual([...h.marks.keys()], persistent);
	assert.equal(removed, 0);
	clearSearchHighlights(h.doc, true);
	assert.equal(removed, 1);
	assert.doesNotThrow(() => clearSearchHighlights(harness(false).doc, true));
	assert.doesNotThrow(() =>
		clearSearchHighlights({ defaultView: null } as Document),
	);
});
test("missing mapping and unsupported highlights report honest errors without painting guessed text", () => {
	const p = projection(["原文"]);
	const h = harness(false);
	assert.throws(() => highlightRange(h.doc, p, 0, 1), /已定位到原文.*不支持/);
	assert.equal(h.marks.size, 0);
	const missing = harness();
	assert.throws(
		() => highlightRange(missing.doc, { raw: "原文", entries: [] }, 0, 1),
		/无法映射/,
	);
	assert.equal(missing.marks.size, 0);
});

test("repainting separate intervals in one document retains all intervals", async () => {
	const { prepareHighlights } = await import("./highlight.ts");
	const p = projection(["甲乙丙丁"]);
	const h = harness();
	const paint = prepareHighlights(h.doc, p, [
		{ start: 0, end: 1 },
		{ start: 2, end: 4 },
	]);
	assert.equal(
		h.marks.size,
		0,
		"validation is separate from painting across documents",
	);
	paint();
	assert.equal(h.marks.size, 1);
	assert.deepEqual(h.paintedRanges(), [
		{ start: [p.entries[0]?.node, 0], end: [p.entries[0]?.node, 1] },
		{ start: [p.entries[0]?.node, 2], end: [p.entries[0]?.node, 4] },
	]);
});

test("study decoration declares its own red color with longhands while preserving glyph color", async () => {
	const { prepareStudyUnderlines } = await import("./highlight.ts");
	for (const [theme, red] of [
		["white", "#c73535"],
		["black", "#ff9993"],
	] as const) {
		const h = harness();
		const range = h.doc.createRange();
		prepareStudyUnderlines(h.doc, [range], [range], theme)();
		const rules = [
			...h.style.textContent.matchAll(
				/::highlight\((folio-study(?:-active)?)\)\{([^}]+)\}/g,
			),
		];
		assert.equal(rules.length, 2);
		for (const rule of rules) {
			const declarations = rule[2] ?? "";
			assert.match(declarations, /(?:^|;)text-decoration-line:underline;/);
			assert.match(declarations, /(?:^|;)text-decoration-style:solid;/);
			assert.ok(declarations.includes(`text-decoration-color:${red};`));
			assert.doesNotMatch(
				declarations,
				/(?:^|;)(?:color|background(?:-color)?):/,
			);
		}
		assert.ok(h.marks.has("folio-study"));
		assert.ok(h.marks.has("folio-study-active"));
	}
});

test("translation decoration uses a lower emphasis dashed red in both themes and clears independently of search", async () => {
	const { prepareStudyUnderlines, clearStudyHighlights } = await import(
		"./highlight.ts"
	);
	for (const [theme, red] of [
		["white", "#c73535"],
		["black", "#ff9993"],
	] as const) {
		const h = harness();
		const range = h.doc.createRange();
		highlightRange(h.doc, projection(["原文"]), 0, 2);
		prepareStudyUnderlines(h.doc, [], [], theme, [range], [range])();
		assert.ok(h.marks.has("folio-translation"));
		assert.ok(h.marks.has("folio-translation-active"));
		const normal =
			h.style.textContent.match(
				/::highlight\(folio-translation\)\{([^}]+)\}/,
			)?.[1] ?? "";
		assert.match(normal, /text-decoration-style:dashed;/);
		assert.ok(normal.includes(`text-decoration-color:${red}b3;`));
		assert.match(normal, /text-underline-position:under left;/);
		assert.doesNotMatch(normal, /(?:^|;)(?:color|background(?:-color)?):/);
		clearStudyHighlights(h.doc);
		assert.equal(h.marks.has("folio-translation"), false);
		assert.equal(h.marks.has("folio-translation-active"), false);
		assert.equal(h.marks.has("folio-search"), true);
	}
});

test("coverage subtraction keeps ruby locator nodes separate and preserves exact Unicode boundaries", async () => {
	const { projectedBaseRanges, uncoveredStudyRanges } = await import(
		"./highlight.ts"
	);
	const p = projection(["甲𠮷", "か\u3099乙"]);
	for (const entry of p.entries)
		Object.assign(entry.node, { parentElement: { closest: () => ({}) } });
	const h = harness();
	const source = projectedBaseRanges(h.doc, p, 0, 4);
	const covered = projectedBaseRanges(h.doc, p, 1, 3);
	const result = uncoveredStudyRanges(h.doc, source, covered) as unknown as {
		start: [Node, number];
		end: [Node, number];
	}[];
	assert.deepEqual(
		result.map(({ start, end }) => ({ start, end })),
		[
			{ start: [p.entries[0]?.node, 0], end: [p.entries[0]?.node, 1] },
			{ start: [p.entries[1]?.node, 2], end: [p.entries[1]?.node, 3] },
		],
	);
	assert.equal(p.raw, "甲𠮷か\u3099乙");
});

test("navigation fade changes only search paint, preserves fading opacity on reflow, and restores original foreground", async () => {
	const { setSearchHighlightOpacity } = await import("./highlight.ts");
	const h = harness();
	const p = projection(["原文"]);
	highlightRange(h.doc, p, 0, 2);
	const marker = h.marks.get("folio-search");
	assert.ok(marker);
	h.marks.set("folio-study", marker);
	h.marks.set("folio-translation", marker);
	setSearchHighlightOpacity(h.doc, 0.5);
	assert.match(h.style.textContent, /background:rgb\(233 203 105 \/ 0.5\)/);
	assert.match(h.style.textContent, /#171717 50%,#282828/);
	highlightRange(h.doc, p, 0, 2);
	assert.match(h.style.textContent, /\/ 0.5\)/, "reflow does not brighten");
	setSearchHighlightOpacity(h.doc, 0);
	assert.match(h.style.textContent, /#171717 0%,#282828/);
	assert.ok(
		h.marks.has("folio-search"),
		"registry survives until final expiry",
	);
	assert.equal(h.marks.get("folio-study"), marker);
	assert.equal(h.marks.get("folio-translation"), marker);
	clearSearchHighlights(h.doc);
	highlightRange(h.doc, p, 0, 2);
	assert.match(h.style.textContent, /\/ 1\)/, "a new target starts bright");
	assert.equal(p.raw, "原文");
});

test("fade captures source foreground and tracks presentation-only theme switches", async () => {
	const { setSearchHighlightOpacity, refreshSearchHighlightForeground } =
		await import("./highlight.ts");
	const h = harness();
	let foreground = "rgb(229, 229, 229)";
	Object.assign(h.doc, { body: {} });
	Object.assign(h.doc.defaultView ?? {}, {
		getComputedStyle: () => ({ color: foreground }),
	});
	const p = projection(["原文"]);
	highlightRange(h.doc, p, 0, 2);
	setSearchHighlightOpacity(h.doc, 0.5);
	assert.match(h.style.textContent, /#171717 50%,rgb\(229, 229, 229\)/);
	const marker = h.marks.get("folio-search");
	foreground = "rgb(40, 40, 40)";
	refreshSearchHighlightForeground(h.doc);
	assert.match(h.style.textContent, /#171717 50%,rgb\(40, 40, 40\)/);
	assert.equal(
		h.marks.get("folio-search"),
		marker,
		"theme changes do not reproject the target",
	);
	foreground = "rgb(229, 229, 229)";
	highlightRange(h.doc, p, 0, 2);
	assert.match(h.style.textContent, /#171717 50%,rgb\(229, 229, 229\)/);
	assert.doesNotMatch(h.style.textContent, /currentColor/);
});
