import assert from "node:assert/strict";
import test from "node:test";
import {
	frameReaderPalette,
	READER_PALETTE_PROPERTIES,
} from "./reader-palette.ts";

test("frame palette reads Reader scope rather than the application color scheme", () => {
	const source = {
		ownerDocument: {
			defaultView: {
				getComputedStyle: (element: unknown) => {
					assert.equal(element, source);
					return {
						getPropertyValue: (name: string) =>
							` light-dark(${name}-light, ${name}-dark) `,
					};
				},
			},
		},
	};
	const doc = {
		defaultView: {
			frameElement: {
				closest: (selector: string) => {
					assert.equal(selector, ".reader-r1");
					return source;
				},
			},
		},
	} as unknown as Document;
	const palette = frameReaderPalette(doc);
	for (const name of READER_PALETTE_PROPERTIES)
		assert.equal(palette[name], `light-dark(${name}-light, ${name}-dark)`);
});
