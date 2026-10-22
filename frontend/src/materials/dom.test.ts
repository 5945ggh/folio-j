import assert from "node:assert/strict";
import test from "node:test";
import {
	imagePrecedesText,
	imageTextOffset,
	readingContentEnd,
	visibleContentRect,
} from "./dom.ts";

test("a leading image remains the first anchor across collapsed whitespace but not a preceding title", () => {
	const whitespace = { data: "\n \t" } as Text;
	const title = { data: "章タイトル" } as Text;
	const body = { data: "本文" } as Text;
	const image = {
		compareDocumentPosition: (node: Node) => (node === body ? 4 : 2),
	};
	assert.equal(
		imagePrecedesText(image, [{ node: whitespace }, { node: body }]),
		true,
	);
	assert.equal(
		imagePrecedesText(image, [{ node: title }, { node: body }]),
		false,
	);
	assert.equal(imagePrecedesText(image, []), true);
});

test("image progress counts its preceding canonical text without modifying the image recovery fraction", () => {
	const chunks = ["前𠮷&", "e", "\u0301", "後"];
	let offset = 0;
	const entries = chunks.map((data) => {
		const start = offset;
		offset += data.length;
		return { node: { data } as Text, start, end: offset };
	});
	const projection = { raw: chunks.join(""), entries };
	const image = (before: number) => ({
		compareDocumentPosition: (node: Node) =>
			entries.findIndex((entry) => entry.node === node) < before ? 2 : 4,
	});
	assert.equal(imageTextOffset(image(0), projection), 0);
	assert.equal(imageTextOffset(image(1), projection), 3);
	assert.equal(imageTextOffset(image(3), projection), 4); // NFC after concatenating the two leaves.
	assert.equal(imageTextOffset(image(2), projection), 4); // Prefix is valid for image progress even across composition.
	assert.equal(imageTextOffset(image(4), projection), 5);
});

test("readable extent ignores empty tail parts and whitespace while including trailing pictures", () => {
	const box = (left: number, bottom: number, width = 20, height = 20) =>
		({ left, bottom, width, height }) as DOMRect;
	const nodes = [
		{ data: " 本文 \n", rect: box(100, 600) },
		{ data: "隠れた文字", rect: box(0, 0, 0, 0) },
		{ data: " \n\t", rect: box(-1000, 10000) },
	];
	let current = { data: "", rect: box(0, 0, 0, 0) };
	const boundaries: number[] = [];
	let images: { getBoundingClientRect: () => DOMRect }[] = [];
	const doc = {
		createRange: () => ({
			setStart: (node: typeof current, start: number) => {
				current = node;
				boundaries.push(start);
			},
			setEnd: (_node: typeof current, end: number) => boundaries.push(end),
			getBoundingClientRect: () => current.rect,
		}),
		querySelectorAll: () => images,
	} as unknown as Document;
	const projection = {
		raw: "",
		entries: nodes.map((node) => ({
			node: node as unknown as Text,
			start: 0,
			end: 0,
		})),
	};
	assert.equal(readingContentEnd(doc, projection, false), 600);
	assert.deepEqual(boundaries.slice(0, 2), [1, 3]);
	assert.equal(readingContentEnd(doc, projection, true), 100);
	images = [{ getBoundingClientRect: () => box(40, 900) }];
	assert.equal(readingContentEnd(doc, projection, false), 900);
	assert.equal(readingContentEnd(doc, projection, true), 40);
	assert.equal(readingContentEnd(doc, { raw: "", entries: [] }, false), 900);
	images = [];
	assert.equal(
		readingContentEnd(
			doc,
			{ raw: "\n", entries: projection.entries.slice(2) },
			false,
		),
		null,
	);
});

test("author visibility-hidden text and pictures cannot extend the readable end", () => {
	const hidden = { visibility: "hidden" };
	const shown = { visibility: "visible" };
	const node = { data: "隠れた文字", parentElement: hidden } as unknown as Text;
	const image = {
		...hidden,
		getBoundingClientRect: () => ({
			left: -100,
			bottom: 1000,
			width: 100,
			height: 100,
		}),
	};
	const doc = {
		defaultView: { getComputedStyle: (element: typeof hidden) => element },
		createRange: () => ({
			setStart: () => {},
			setEnd: () => {},
			getBoundingClientRect: () => ({
				left: 0,
				bottom: 600,
				width: 10,
				height: 10,
			}),
		}),
		querySelectorAll: () => [image],
	} as unknown as Document;
	const projection = {
		raw: node.data,
		entries: [{ node, start: 0, end: node.data.length }],
	};
	assert.equal(readingContentEnd(doc, projection, false), null);
	const visibleNode = { data: "本文", parentElement: shown } as unknown as Text;
	projection.entries.push({
		node: visibleNode,
		start: node.data.length,
		end: node.data.length + 2,
	});
	assert.equal(readingContentEnd(doc, projection, false), 600);
	assert.equal(readingContentEnd(doc, projection, true), 0);
});

test("author overflow clipping limits text and image ends in both reading directions", () => {
	for (const vertical of [false, true]) {
		for (const overflow of ["hidden", "clip"]) {
			for (const image of [false, true]) {
				const parent = {
					parentElement: null,
					clientLeft: 0,
					clientTop: 0,
					clientWidth: 100,
					clientHeight: 100,
					getBoundingClientRect: () => ({ left: 0, top: 0 }),
				};
				let bounds = {
					left: vertical ? -1000 : 0,
					bottom: vertical ? 20 : 1020,
					width: 20,
					height: 20,
				};
				const child = {
					parentElement: parent,
					getBoundingClientRect: () => bounds,
				};
				const node = { data: "本文", parentElement: child } as unknown as Text;
				const doc = {
					defaultView: {
						getComputedStyle: (element: unknown) => ({
							visibility: "visible",
							overflowX: element === parent && vertical ? overflow : "visible",
							overflowY: element === parent && !vertical ? overflow : "visible",
						}),
					},
					createRange: () => ({
						setStart: () => {},
						setEnd: () => {},
						getBoundingClientRect: () => bounds,
					}),
					querySelectorAll: () => (image ? [child] : []),
				} as unknown as Document;
				const projection = {
					raw: "本文",
					entries: image ? [] : [{ node, start: 0, end: 2 }],
				};
				assert.equal(readingContentEnd(doc, projection, vertical), null);
				bounds = {
					left: vertical ? -10 : 0,
					bottom: vertical ? 20 : 110,
					width: 20,
					height: 20,
				};
				assert.equal(
					readingContentEnd(doc, projection, vertical),
					vertical ? 0 : 100,
				);
			}
		}
	}
});

test("study entry geometry rejects hidden and author-clipped ranges before screen placement", () => {
	const rect = { left: 0, width: 50, bottom: 30, height: 20 } as DOMRect;
	const parent = {
		parentElement: null,
		clientLeft: 0,
		clientTop: 0,
		clientWidth: 20,
		clientHeight: 20,
		getBoundingClientRect: () => ({ left: 0, top: 0 }),
	} as unknown as Element;
	let style = {
		visibility: "hidden",
		overflowX: "visible",
		overflowY: "visible",
	};
	const doc = {
		defaultView: { getComputedStyle: () => style },
	} as unknown as Document;
	assert.equal(visibleContentRect(doc, rect, parent), null);
	style = { visibility: "visible", overflowX: "hidden", overflowY: "hidden" };
	assert.deepEqual(visibleContentRect(doc, rect, parent), {
		left: 0,
		right: 20,
		top: 10,
		bottom: 20,
	});
	assert.equal(
		visibleContentRect(doc, { ...rect, left: 30 } as DOMRect, parent),
		null,
	);
});
