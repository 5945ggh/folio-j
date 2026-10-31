import assert from "node:assert/strict";
import test from "node:test";
import type { Projection } from "./dom.ts";
import { readerLookupWindow } from "./reader-lookup-window.ts";

function passage(values: string[], blocks: number[] = []) {
	const nodes = values.map((data) => ({ data, nodeType: 3 }) as Text);
	const groups = [...new Set(blocks)].map((group) => ({
		contains: (node: Node) => blocks[nodes.indexOf(node as Text)] === group,
	}));
	let start = 0;
	const entries = nodes.map((node, i) => {
		Object.assign(node, {
			parentElement: { closest: () => groups[blocks[i] ?? -1] ?? null },
		});
		const entry = { node, start, end: start + node.data.length };
		start = entry.end;
		return entry;
	});
	return {
		nodes,
		projection: { raw: values.join(""), entries } satisfies Projection,
	};
}

test("canonical newlines stop a lookup even when adjacent paragraphs have no punctuation", () => {
	const { projection, nodes } = passage([
		"前の段落\n",
		"猫と歩く\n",
		"後ろの段落",
	]);
	const node = nodes[1];
	assert.ok(node);
	const range = readerLookupWindow(projection, node, 6);
	assert.deepEqual(range, { start: 5, end: 9 });
	assert.equal(
		Array.from(projection.raw).slice(range.start, range.end).join(""),
		"猫と歩く",
	);
});

test("semantic paragraphs remain separate when a source or fixture has no newline", () => {
	const { projection, nodes } = passage(
		["前の段落", "猫", "と", "歩く", "後ろの段落"],
		[0, 1, 1, 1, 2],
	);
	const node = nodes[3];
	assert.ok(node);
	assert.deepEqual(readerLookupWindow(projection, node, 6), {
		start: 4,
		end: 8,
	});
});

test("ruby and inline leaves preserve global NFC code points within the paragraph", () => {
	const { projection, nodes } = passage(
		["😀前\n", "か", "\u3099", "猫", "と歩く", "\n後ろ"],
		[0, 1, 1, 1, 1, 2],
	);
	const node = nodes[3];
	assert.ok(node);
	const range = readerLookupWindow(projection, node, 4);
	assert.deepEqual(range, { start: 3, end: 8 });
	assert.equal(
		Array.from(projection.raw.normalize("NFC"))
			.slice(range.start, range.end)
			.join(""),
		"が猫と歩く",
	);
});

test("an inline line break limits context without losing the click's local offset", () => {
	const { projection, nodes } = passage(["前の行\n猫と歩く\n後ろの行"], [0]);
	const node = nodes[0];
	assert.ok(node);
	assert.deepEqual(readerLookupWindow(projection, node, 6), {
		start: 4,
		end: 8,
	});
});

test("a long paragraph stays bounded around a word-middle click", () => {
	const { projection, nodes } = passage(["字".repeat(5000)], [0]);
	const node = nodes[0];
	assert.ok(node);
	assert.deepEqual(readerLookupWindow(projection, node, 2500), {
		start: 2244,
		end: 2756,
	});
});
