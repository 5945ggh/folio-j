import type { Projection } from "./dom.ts";
import { visibleContentRect } from "./dom.ts";

/** Hit actual base glyphs, rather than the nearest caret in whitespace. Coordinates are document-local. */
export function textPointAt(
	doc: Document,
	x: number,
	y: number,
	projection?: Projection,
) {
	const extended = doc as Document & {
		caretRangeFromPoint?: (x: number, y: number) => Range | null;
	};
	const caret = doc.caretPositionFromPoint?.(x, y);
	const fallback = caret ? null : extended.caretRangeFromPoint?.(x, y);
	const node = caret?.offsetNode ?? fallback?.startContainer;
	const offset = caret?.offset ?? fallback?.startOffset;
	if (
		node?.nodeType !== 3 ||
		offset === undefined ||
		node.parentElement?.closest(
			"rt,rp,a,button,input,textarea,select,[contenteditable],[data-reader-control]",
		)
	)
		return null;
	const entry = projection?.entries.find((item) => item.node === node);
	if (projection && !entry) return null;
	const text = node as Text;
	const segments = new Intl.Segmenter(undefined, {
		granularity: "grapheme",
	}).segment(text.data);
	// The caret can be at either edge. Segment containment avoids walking the paragraph.
	const adjacent = [
		segments.containing(offset),
		segments.containing(offset - 1),
	];
	const seen = new Set<number>();
	for (const item of adjacent) {
		if (!item || seen.has(item.index)) continue;
		const { segment, index: start } = item;
		seen.add(start);
		const end = start + segment.length;
		if (!segment.trim()) continue;
		const range = doc.createRange();
		range.setStart(node, start);
		range.setEnd(node, end);
		for (const rect of Array.from(range.getClientRects())) {
			const visible = visibleContentRect(doc, rect, node.parentElement);
			if (
				visible &&
				x >= visible.left &&
				x < visible.right &&
				y >= visible.top &&
				y < visible.bottom
			)
				return {
					node: text,
					start,
					end,
					range,
					rect,
					rawStart: entry ? entry.start + start : undefined,
				};
		}
	}
	return null;
}
