import assert from "node:assert/strict";
import test from "node:test";
import type { Chapter } from "./api.ts";
import type { Projection } from "./dom.ts";
import { captureNativeSelection, referenceParts } from "./reader-selection.ts";

type TestNode = {
	nodeType: number;
	data: string;
	length: number;
	childNodes: TestNode[];
	parentNode: TestNode | null;
	parentElement: TestNode | null;
	ownerDocument: Document;
	tag: string;
	contains: (node: TestNode) => boolean;
	closest: (selector: string) => TestNode | null;
	compareDocumentPosition: (node: TestNode) => number;
};
function fixture(chunks = ["甲𠮷", "カ", "\u3099乙😀。"], resourceStart = 0) {
	let range: {
		startContainer: Node;
		startOffset: number;
		endContainer: Node;
		endOffset: number;
	};
	let count = 1,
		collapsed = false;
	const doc = {
		getSelection: () => ({
			rangeCount: count,
			isCollapsed: collapsed,
			getRangeAt: () => range,
		}),
	} as unknown as Document;
	const nodes: TestNode[] = [];
	const node = (
		data: string,
		tag = "",
		parent: TestNode | null = null,
	): TestNode => {
		const value: TestNode = {
			data,
			length: data.length,
			tag,
			nodeType: tag ? 1 : 3,
			childNodes: [],
			parentNode: parent,
			parentElement: parent,
			ownerDocument: doc,
			contains(other) {
				for (let at: TestNode | null = other; at; at = at.parentNode)
					if (at === this) return true;
				return false;
			},
			closest(selector) {
				for (let at: TestNode | null = this; at; at = at.parentNode)
					if (selector.split(",").includes(at.tag)) return at;
				return null;
			},
			compareDocumentPosition(other) {
				return nodes.indexOf(other) < nodes.indexOf(this) ? 2 : 4;
			},
		};
		nodes.push(value);
		parent?.childNodes.push(value);
		return value;
	};
	const root = node("", "body");
	Object.assign(doc, { body: root });
	const texts = chunks.map((value) => node(value, "", node("", "span", root)));
	let offset = 0;
	const projection: Projection = {
		raw: chunks.join(""),
		entries: texts.map((text) => {
			const start = offset;
			offset += text.length;
			return { node: text as unknown as Text, start, end: offset };
		}),
	};
	const text = chunks.join("").normalize("NFC");
	const resource = {
		id: "r",
		text: "前".repeat(resourceStart) + text,
		text_sha256: "a".repeat(64),
	} as Chapter["resources"][number];
	const part = {
		resource_id: "r",
		spine_index: 4,
		start: resourceStart,
		end: resourceStart + Array.from(text).length,
	} as Chapter["parts"][number];
	const select = (
		start: TestNode,
		startOffset: number,
		end: TestNode,
		endOffset: number,
	) => {
		range = {
			startContainer: start as unknown as Node,
			startOffset,
			endContainer: end as unknown as Node,
			endOffset,
		};
	};
	return {
		root,
		node,
		texts,
		select,
		projection,
		doc,
		capture: () =>
			captureNativeSelection(doc, projection, part, resource, "m", "v"),
		count: (value: number) => {
			count = value;
		},
		collapse: () => {
			collapsed = true;
		},
	};
}

test("U1/U2/U6: native UTF-16 endpoints become globally NFC codepoints at the exact spine occurrence", () => {
	const h = fixture(undefined, 10);
	const [first, second, third] = h.texts;
	assert.ok(first && second && third);
	h.select(first, 1, third, 4);
	assert.deepEqual(h.capture().ranges[0], {
		resource_id: "r",
		spine_index: 4,
		start: 11,
		end: 15,
		exact: "𠮷ガ乙😀",
		prefix: "",
		suffix: "",
		text_sha256: "a".repeat(64),
	});
	h.select(second, 0, third, 1);
	assert.equal(h.capture().ranges[0]?.exact, "ガ");
	assert.equal(h.capture().ranges[0]?.start, 12);
});

test("U3/U4/U9: surrogate splits, unstable NFC boundaries, empty/multiple ranges and foreign endpoints reject", () => {
	const h = fixture();
	const [first, second, third] = h.texts;
	assert.ok(first && second && third);
	for (const [left, a, right, b] of [
		[first, 2, third, 4],
		[first, 1, third, 3],
		[second, 1, third, 4],
		[first, 0, third, 0],
	] as const) {
		h.select(left, a, right, b);
		assert.throws(h.capture, /边界切开/);
	}
	h.select(first, 0, third, 4);
	h.count(2);
	assert.throws(h.capture, /连续/);
	h.count(1);
	h.collapse();
	assert.throws(h.capture, /连续/);
	const other = fixture();
	const outside = other.texts[0];
	assert.ok(outside);
	const fresh = fixture();
	const inside = fresh.texts[0];
	assert.ok(inside);
	fresh.select(inside, 0, outside, 1);
	assert.throws(fresh.capture, /当前正文/);
});

test("U5/U8: element child indexes and ruby bases exclude rt/rp, whose endpoints reject", () => {
	const h = fixture(["漢", "字😀"]);
	const [first, last] = h.texts;
	assert.ok(first && last);
	const ruby = first.parentNode;
	assert.ok(ruby);
	ruby.tag = "ruby";
	const rt = h.node("", "rt", ruby);
	const reading = h.node("かん", "", rt);
	h.select(h.root, 0, h.root, 2);
	assert.equal(h.capture().ranges[0]?.exact, "漢字😀");
	h.select(ruby, 0, ruby, 1);
	assert.equal(h.capture().ranges[0]?.exact, "漢");
	h.select(rt, 0, last, 1);
	assert.throws(h.capture, /注音/);
	h.select(reading, 0, last, 1);
	assert.throws(h.capture, /注音/);
	h.select(first, 0, last, 3);
	assert.equal(h.capture().ranges[0]?.exact, "漢字😀");
});

test("element boundary between leaves respects document order outside endpoint ancestors", () => {
	const h = fixture(["甲", "乙", "丙"]);
	const middle = h.texts[1]?.parentElement;
	assert.ok(middle);
	h.select(middle, 0, h.root, 3);
	assert.equal(h.capture().ranges[0]?.exact, "乙丙");
});

test("full reference projection handles canonical ranges across parts and repeated spines without guessing", () => {
	const resource = (id: string, text: string) => ({
		id,
		text,
		text_sha256: "a".repeat(64),
	});
	const chapter = {
		parts: [
			{ resource_id: "r", spine_index: 0, start: 0, end: 2 },
			{ resource_id: "r", spine_index: 0, start: 2, end: 4 },
			{ resource_id: "s", spine_index: 1, start: 0, end: 2 },
			{ resource_id: "r", spine_index: 2, start: 0, end: 4 },
		],
		resources: [resource("r", "甲𠮷乙丙"), resource("s", "丁戊")],
	} as Chapter;
	const ranges = [
		{ resource_id: "r", spine_index: 0, start: 1, end: 4, exact: "𠮷乙丙" },
		{ resource_id: "s", spine_index: 1, start: 0, end: 1, exact: "丁" },
	];
	const firstTarget = ranges[0],
		secondTarget = ranges[1];
	assert.ok(firstTarget && secondTarget);

	assert.deepEqual(
		[...referenceParts(chapter, ranges)],
		[
			[0, [{ start: 1, end: 2 }]],
			[1, [{ start: 0, end: 2 }]],
			[2, [{ start: 0, end: 1 }]],
		],
	);
	assert.deepEqual(
		[
			...referenceParts(chapter, [
				{ resource_id: "r", spine_index: 2, start: 1, end: 3 },
			]),
		],
		[[3, [{ start: 1, end: 3 }]]],
	);
	assert.throws(
		() => referenceParts(chapter, [{ ...firstTarget, exact: "錯" }]),
		/快照/,
	);
	assert.throws(
		() => referenceParts(chapter, [{ ...firstTarget, spine_index: 9 }]),
		/完整/,
	);
	assert.throws(
		() => referenceParts(chapter, [secondTarget, firstTarget]),
		/完整/,
	);
	const gap = structuredClone(chapter);
	gap.parts.splice(1, 0, {
		resource_id: "s",
		spine_index: 1,
		start: 0,
		end: 2,
		html: "",
		leaf_start: 0,
		leaf_end: 0,
	});
	assert.throws(() => referenceParts(gap, [firstTarget]), /不连续/);
});
