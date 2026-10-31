import { textPointAt } from "./text-point.ts";

/** Neighboring Japanese inline fragments form one passage. Stop at a translation, line break or ruby annotation. */
export function dictionaryPassage(container: Element, x: number, y: number) {
	const doc = container.ownerDocument;
	const point = textPointAt(doc, x, y);
	if (
		!point ||
		!container.contains(point.node) ||
		point.node.parentElement?.closest('[lang="zh"]')
	)
		return null;
	const block = point.node.parentElement?.closest(
		'[data-dict-role="exam"],[data-dict-role="def2"],p,li,div',
	);
	if (!block || !container.contains(block)) return null;
	const walker = doc.createTreeWalker(
		block,
		NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
	);
	let nodes: Text[] = [];
	let pointIndex = -1;
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (
			node.nodeType === Node.ELEMENT_NODE &&
			(node as Element).matches('br,[lang="zh"],div,p,li')
		) {
			if (pointIndex >= 0) break;
			nodes = [];
		}
		if (
			node.nodeType !== Node.TEXT_NODE ||
			node.parentElement?.closest('[lang="zh"],rt,rp')
		)
			continue;
		if (node === point.node) pointIndex = nodes.length;
		nodes.push(node as Text);
	}
	if (pointIndex < 0) return null;
	const prefix = nodes
		.slice(0, pointIndex)
		.reduce((total, node) => total + node.length, 0);
	const raw = nodes.map((node) => node.data).join("");
	const offset = Array.from(raw.slice(0, prefix + point.start)).length;
	const chars = Array.from(raw);
	const first = Math.max(0, offset - 128);
	const text = chars.slice(first, offset + 129).join("");
	return {
		anchor: point.rect,
		text,
		offset: offset - first,
		range(start: number, end: number) {
			const from = chars.slice(0, first + start).join("").length;
			const to = chars.slice(0, first + end).join("").length;
			const range = doc.createRange();
			let base = 0;
			for (const node of nodes) {
				if (base <= from && from < base + node.length)
					range.setStart(node, from - base);
				if (base < to && to <= base + node.length) {
					range.setEnd(node, to - base);
					return range;
				}
				base += node.length;
			}
			return null;
		},
	};
}
export type DictionaryPassage = NonNullable<
	ReturnType<typeof dictionaryPassage>
>;
