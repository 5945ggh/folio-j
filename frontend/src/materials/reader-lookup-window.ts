import type { Projection } from "./dom.ts";
import { rawBoundary } from "./position.ts";

const PARAGRAPH =
	"p,li,dt,dd,pre,blockquote,h1,h2,h3,h4,h5,h6,td,th,div,section,article,aside,header,footer";
const BREAK = /[\r\n\u2028\u2029]/u;

/** A lookup cannot join separate paragraphs. Ruby and inline formatting stay in the canonical passage. */
export function readerLookupWindow(
	projection: Projection,
	node: Text,
	offset: number,
) {
	const text = Array.from(projection.raw.normalize("NFC"));
	if (!Number.isInteger(offset) || offset < 0 || offset >= text.length)
		throw new Error("查词落点超出正文");
	let first = 0,
		last = text.length;
	const block = node.parentElement?.closest(PARAGRAPH);
	if (block) {
		const entries = projection.entries.filter((entry) =>
			block.contains(entry.node),
		);
		const begin = entries[0],
			end = entries.at(-1);
		if (!begin || !end) throw new Error("查词段落不属于正文投影");
		first = rawBoundary(projection.raw, begin.start);
		last = rawBoundary(projection.raw, end.end);
	}
	// Scan only the bounded neighborhood, never the remainder of a long passage.
	let start = Math.max(first, offset - 256);
	let end = Math.min(last, start + 512);
	for (let i = offset - 1; i >= start; i--)
		if (BREAK.test(text[i] ?? "")) {
			start = i + 1;
			break;
		}
	for (let i = offset; i < end; i++)
		if (BREAK.test(text[i] ?? "")) {
			end = i;
			break;
		}
	if (offset < start || offset >= end)
		throw new Error("查词落点不在段落正文中");
	return { start, end };
}
