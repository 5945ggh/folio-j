import { nearestLineBoundary, rawBoundary, rawOffset } from "./position";
export type Projection = ReturnType<typeof projectPart>;
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
			leaf.children.length
		)
			throw new Error("正文叶子身份失配");
		for (const node of leaf.childNodes) {
			if (node.nodeType !== 3) continue;
			const text = node as Text;
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
export function textRect(doc: Document, projection: Projection, point: number) {
	const offset = rawOffset(projection.raw, point);
	const entry =
		projection.entries.find((e) => e.end > offset) ?? projection.entries.at(-1);
	if (!entry) return null;
	const range = doc.createRange();
	const local = Math.min(entry.node.length, offset - entry.start);
	range.setStart(entry.node, local);
	range.setEnd(entry.node, Math.min(entry.node.length, local + 1));
	return range.getBoundingClientRect();
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
