import assert from "node:assert/strict";
import test from "node:test";
import { imagePrecedesText, imageTextOffset } from "./dom.ts";

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
