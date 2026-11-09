import { rawBoundary, rawOffset } from "../materials/position.ts";
import { textPointAt } from "../materials/text-point.ts";

function isChinese(element: Element | null, container: Element) {
	const localized = element?.closest("[lang]");
	return (
		!!localized &&
		container.contains(localized) &&
		/^zh(?:-|$)/i.test(localized.getAttribute("lang") ?? "")
	);
}

const blockSelector =
	'[data-dict-role="exam"],[data-dict-role="def2"],p,li,div,section,article,blockquote,pre,h1,h2,h3,h4,h5,h6,dt,dd,td,th';

/** Neighboring Japanese inline fragments form one passage. Stop at a translation, line break or ruby annotation. */
export function dictionaryPassage(container: Element, x: number, y: number) {
	const doc = container.ownerDocument;
	const point = textPointAt(doc, x, y);
	if (
		!point ||
		!container.contains(point.node) ||
		isChinese(point.node.parentElement, container) ||
		!/[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u.test(
			point.node.data.slice(point.start, point.end),
		)
	)
		return null;
	const block = point.node.parentElement?.closest(blockSelector);
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
			(node as Element).matches(
				`br,[lang|="zh"],a,button,input,textarea,select,[contenteditable],${blockSelector}`,
			)
		) {
			if (pointIndex >= 0) break;
			nodes = [];
		}
		if (
			node.nodeType !== Node.TEXT_NODE ||
			isChinese(node.parentElement, container) ||
			node.parentElement?.closest(
				"rt,rp,a,button,input,textarea,select,[contenteditable]",
			)
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
	let offset: number;
	try {
		offset = rawBoundary(raw, prefix + point.start);
	} catch {
		return null;
	}
	const chars = Array.from(raw.normalize("NFC"));
	const minimum = Math.max(0, offset - 128);
	const maximum = Math.min(chars.length, offset + 129);
	let first = offset,
		last = offset + 1;
	while (first > minimum && !/[\r\n\u2028\u2029]/u.test(chars[first - 1] ?? ""))
		first--;
	while (last < maximum && !/[\r\n\u2028\u2029]/u.test(chars[last] ?? ""))
		last++;
	const text = chars.slice(first, last).join("");
	return {
		anchor: point.rect,
		text,
		offset: offset - first,
		range(start: number, end: number) {
			let from: number, to: number;
			try {
				from = rawOffset(raw, first + start);
				to = rawOffset(raw, first + end);
			} catch {
				return null;
			}
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
