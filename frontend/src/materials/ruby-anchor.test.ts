import assert from "node:assert/strict";
import test from "node:test";
import { textAnchorRect, textRect, textSamplingTarget } from "./dom.ts";

function anchorAtKana(vertical = false) {
	const base = { left: 40, right: 62, top: 100, bottom: 125 };
	const boundaries: number[] = [];
	const node = { length: 24, parentElement: {} } as Text;
	const doc = {
		createRange: () => ({
			setStart: (_node: Text, offset: number) => boundaries.push(offset),
			setEnd: (_node: Text, offset: number) => boundaries.push(offset),
			getBoundingClientRect: () => base,
		}),
	} as unknown as Document;
	const raw = "うんめー、ともちもち嬉しそうに頑張る。";
	return {
		rect: textRect(
			doc,
			{ raw, entries: [{ node, start: 0, end: raw.length }] },
			0,
			vertical,
			22,
		),
		boundaries,
	};
}
test("kana line-start leaves one configured em above the base for later ruby without changing offset", () => {
	const { rect, boundaries } = anchorAtKana();
	assert.equal(rect?.top, 78);
	assert.equal(rect?.right, 62);
	assert.deepEqual(boundaries, [0, 1]);
});
test("vertical kana column-start leaves one em to the right for later ruby", () => {
	const { rect, boundaries } = anchorAtKana(true);
	assert.equal(rect?.top, 100);
	assert.equal(rect?.right, 84);
	assert.deepEqual(boundaries, [0, 1]);
});
test("restore then capture applies inverse margins and cannot drift to a preceding line or column", () => {
	const base = { left: 100, right: 125, top: 100, bottom: 125 };
	for (const vertical of [false, true]) {
		let point = vertical ? base.right : base.top;
		for (let pass = 0; pass < 20; pass++) {
			const rect = textAnchorRect(
				{
					...base,
					...(vertical
						? { right: point, left: point - 25 }
						: { top: point, bottom: point + 25 }),
				},
				22,
				vertical,
			);
			const viewportLeadingEdge = vertical ? rect.right : rect.top;
			point = textSamplingTarget(viewportLeadingEdge, 22, vertical);
			assert.equal(point, vertical ? base.right : base.top);
		}
	}
});
test("invalid font geometry conservatively retains the base", () => {
	const base = { left: 40, right: 62, top: 100, bottom: 125 };
	for (const size of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
		assert.equal(textAnchorRect(base, size).top, base.top);
		assert.equal(textAnchorRect(base, size, true).right, base.right);
	}
});
test("a hidden or non-finite raw range cannot become a located anchor through the one-em gutter", () => {
	for (const base of [
		{ left: 0, right: 0, top: 0, bottom: 0 },
		{ left: Number.NaN, right: 22, top: 100, bottom: 125 },
		{ left: 40, right: 62, top: 100, bottom: Number.POSITIVE_INFINITY },
	]) {
		const node = { length: 1 } as Text;
		const doc = {
			createRange: () => ({
				setStart: () => {},
				setEnd: () => {},
				getBoundingClientRect: () => base,
			}),
		} as unknown as Document;
		for (const vertical of [false, true])
			assert.equal(
				textRect(
					doc,
					{ raw: "字", entries: [{ node, start: 0, end: 1 }] },
					0,
					vertical,
					22,
				),
				null,
			);
	}
});
test("a genuine caret with one nonzero raw dimension remains a valid anchor", () => {
	const node = { length: 1 } as Text;
	const doc = {
		createRange: () => ({
			setStart: () => {},
			setEnd: () => {},
			getBoundingClientRect: () => ({
				left: 40,
				right: 40,
				top: 100,
				bottom: 125,
			}),
		}),
	} as unknown as Document;
	assert.equal(
		textRect(
			doc,
			{ raw: "字", entries: [{ node, start: 0, end: 1 }] },
			1,
			false,
			22,
		)?.top,
		78,
	);
});
