import { nearestLineBoundary, rawBoundary, rawOffset } from "./position.ts";
export type Projection = ReturnType<typeof projectPart>;

/** Image anchors keep their own local fraction; display progress counts canonical text before them. */
export function imageTextOffset(
	image: Pick<Element, "compareDocumentPosition">,
	projection: Projection,
): number {
	let end = 0;
	for (const entry of projection.entries) {
		if ((image.compareDocumentPosition(entry.node) & 2) !== 0) end = entry.end;
	}
	return Array.from(projection.raw.slice(0, end).normalize("NFC")).length;
}

/** Collapsed whitespace before a leading image must not make its anchor skip to later text. */
export function imagePrecedesText(
	image: Pick<Element, "compareDocumentPosition">,
	entries: readonly { node: Text }[],
): boolean {
	return !entries.some(
		({ node }) =>
			node.data.trim().length > 0 &&
			(image.compareDocumentPosition(node) & 2) !== 0,
	);
}
export function projectPart(
	doc: Document,
	expected: string,
	leafStart: number,
) {
	const leaves = Array.from(
		doc.querySelectorAll<HTMLElement>("[data-locator-leaf]"),
	);
	let raw = "";
	const entries: { node: Text; start: number; end: number }[] = [];
	for (const [index, leaf] of leaves.entries()) {
		if (
			leaf.dataset.locatorLeaf !== String(leafStart + index) ||
			leaf.closest("rt,rp") ||
			Array.from(leaf.children).some(
				(child) =>
					!child.matches("ruby[data-auto-ruby]") ||
					child.children.length !== 1 ||
					Array.from(child.children).some(
						(annotation) =>
							!annotation.matches("rt") || annotation.children.length > 0,
					),
			)
		)
			throw new Error("正文叶子身份失配");
		const walker = doc.createTreeWalker(leaf, 4);
		let node = walker.nextNode();
		while (node) {
			const text = node as Text;
			node = walker.nextNode();
			if (text.parentElement?.closest("rt,rp")) continue;
			entries.push({
				node: text,
				start: raw.length,
				end: raw.length + text.length,
			});
			raw += text.data;
		}
	}
	if (raw.normalize("NFC") !== expected) throw new Error("正文定位投影失配");
	return { raw, entries };
}
export function textRect(
	doc: Document,
	projection: Projection,
	point: number,
	vertical = false,
	fontSize = 0,
) {
	const offset = rawOffset(projection.raw, point);
	const entry =
		projection.entries.find((e) => e.end > offset) ?? projection.entries.at(-1);
	if (!entry) return null;
	const range = doc.createRange();
	const local = Math.min(entry.node.length, offset - entry.start);
	range.setStart(entry.node, local);
	range.setEnd(entry.node, Math.min(entry.node.length, local + 1));
	const rect = range.getBoundingClientRect();
	if (
		![rect.left, rect.right, rect.top, rect.bottom].every(Number.isFinite) ||
		(rect.right <= rect.left && rect.bottom <= rect.top)
	)
		return null;
	return textAnchorRect(rect, fontSize, vertical);
}
/** A fixed body-font one-em leading gutter reveals the entire line's ruby even when the anchor starts with kana. */
export function textAnchorRect(
	base: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
	fontSize: number,
	vertical = false,
): DOMRect {
	const margin = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 0;
	const top = base.top - (vertical ? 0 : margin);
	const right = base.right + (vertical ? margin : 0);
	const bounds = {
		left: base.left,
		right,
		top,
		bottom: base.bottom,
		x: base.left,
		y: top,
		width: right - base.left,
		height: base.bottom - top,
	};
	return { ...bounds, toJSON: () => bounds };
}
/** Sampling is the inverse of the fixed leading gutter used by restoration. */
export function textSamplingTarget(
	target: number,
	fontSize: number,
	vertical: boolean,
): number {
	const margin = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 0;
	return target + (vertical ? -margin : margin);
}
export function nearestText(
	doc: Document,
	projection: Projection,
	target: number,
	vertical: boolean,
) {
	let best:
		| { entry: Projection["entries"][number]; distance: number }
		| undefined;
	for (const entry of projection.entries) {
		const range = doc.createRange();
		range.selectNodeContents(entry.node);
		const rect = range.getBoundingClientRect();
		if (!rect.width && !rect.height) continue;
		const start = vertical ? rect.left : rect.top,
			end = vertical ? rect.right : rect.bottom;
		const distance =
			target < start ? start - target : target > end ? target - end : 0;
		if (!best || distance < best.distance) best = { entry, distance };
	}
	if (!best) return undefined;
	const entry = best.entry;
	const offsets: number[] = [];
	let offset = 0;
	for (const character of entry.node.data) {
		offsets.push(offset);
		offset += character.length;
	}
	if (!offsets.length) return undefined;
	const coordinate = (index: number) => {
		const begin = offsets[index] ?? 0;
		const end = offsets[index + 1] ?? entry.node.length;
		const range = doc.createRange();
		range.setStart(entry.node, begin);
		range.setEnd(entry.node, end);
		const rect = range.getBoundingClientRect();
		return vertical ? -rect.right : rect.top;
	};
	const index = nearestLineBoundary(
		offsets.length,
		vertical ? -target : target,
		coordinate,
	);
	for (
		let candidate = index;
		candidate < Math.min(offsets.length, index + 8);
		candidate++
	) {
		try {
			return rawBoundary(
				projection.raw,
				entry.start + (offsets[candidate] ?? 0),
			);
		} catch {
			/* Snap past an unstable NFC boundary. */
		}
	}
	return undefined;
}
export function htmlEscape(value: string) {
	return value.replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			] ?? c,
	);
}
