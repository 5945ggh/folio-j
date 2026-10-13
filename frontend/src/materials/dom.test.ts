import assert from "node:assert/strict";
import test from "node:test";
import { imagePrecedesText } from "./dom.ts";

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
