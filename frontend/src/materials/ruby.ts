import type { ReadingsToken } from "./api";
import { type Projection, projectPart } from "./dom.ts";
import { rawBoundary } from "./position.ts";

export function hiragana(reading: string): string {
	return reading
		.normalize("NFC")
		.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}
/** Strip matching kana at either edge; start is a code-point offset within the token. */
export function rubyLabel(surface: string, reading: string) {
	const kana = hiragana(reading);
	if (!/\p{Script=Han}/u.test(surface) || !/^[ぁ-ゖー]+$/u.test(kana))
		return null;
	const prefix = surface.match(/^[ぁ-ゖァ-ヶー]+/u)?.[0] ?? "";
	const suffix = surface.match(/[ぁ-ゖァ-ヶー]+$/u)?.[0] ?? "";
	const leading = kana.startsWith(hiragana(prefix)) ? prefix.length : 0;
	const trailing = kana.endsWith(hiragana(suffix)) ? suffix.length : 0;
	if (leading + trailing >= kana.length)
		return { surface, reading: kana, start: 0 };
	return {
		surface: surface.slice(leading, surface.length - trailing),
		reading: kana.slice(leading, kana.length - trailing),
		start: Array.from(surface.slice(0, leading)).length,
	};
}
/** Build global NFC code-point boundaries once, retaining only verified raw boundaries. */
export function rubyBoundaries(raw: string): Array<number | undefined> {
	const result: Array<number | undefined> = [];
	if (raw === raw.normalize("NFC")) {
		let offset = 0;
		result.push(0);
		for (const character of raw) {
			offset += character.length;
			result.push(offset);
		}
		return result;
	}
	const segments = Array.from(
		new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(raw),
	);
	if (
		segments.map((s) => s.segment.normalize("NFC")).join("") !==
		raw.normalize("NFC")
	)
		return [];
	let point = 0;
	for (const { segment, index } of segments) {
		if (segment.length <= 64)
			for (let local = 0; local <= segment.length; local++) {
				try {
					result[point + rawBoundary(segment, local)] = index + local;
				} catch {
					/* unstable NFC interior */
				}
			}
		point += Array.from(segment.normalize("NFC")).length;
		result[point] = index + segment.length;
	}
	return result;
}
function firstAfter<T>(
	items: T[],
	value: number,
	end: (item: T) => number,
): number {
	let low = 0,
		high = items.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (end(items[middle] as T) <= value) low = middle + 1;
		else high = middle;
	}
	return low;
}
/** Only replace a single original text node. Cross-format and original ruby overlaps are skipped. */
export function applyAutomaticRuby(
	doc: Document,
	projection: Projection,
	tokens: ReadingsToken[],
	partStart: number,
): Element[] {
	const selection = doc.getSelection?.();
	const endpoint = (
		node: Node | null,
		offset: number,
	): { raw: number } | { node: Node | null; offset: number } => {
		const entry = projection.entries.find((entry) => entry.node === node);
		if (entry) return { raw: entry.start + offset };
		// Native Select All and selection across inline markup can use element boundaries.
		if (node?.nodeType === 1) {
			const element = node as Element;
			if (
				element.closest("rt,rp") ||
				!projection.entries.some((entry) => element.contains(entry.node))
			)
				return { node, offset };
			const boundary = doc.createRange();
			boundary.setStart(node, offset);
			boundary.collapse(true);
			for (const entry of projection.entries) {
				if (boundary.comparePoint(entry.node, 0) >= 0)
					return { raw: entry.start };
				if (boundary.comparePoint(entry.node, entry.node.length) >= 0)
					return { raw: entry.end };
			}
			return { raw: projection.raw.length };
		}
		return { node, offset };
	};
	const savedSelection =
		selection && !selection.isCollapsed
			? {
					anchor: endpoint(selection.anchorNode, selection.anchorOffset),
					focus: endpoint(selection.focusNode, selection.focusOffset),
				}
			: null;
	const created: Element[] = [];
	const original = new Map<Element, { start: number; end: number }>();
	for (const entry of projection.entries) {
		const ruby = entry.node.parentElement?.closest("ruby");
		if (!ruby) continue;
		const range = original.get(ruby);
		original.set(ruby, {
			start: Math.min(range?.start ?? entry.start, entry.start),
			end: Math.max(range?.end ?? entry.end, entry.end),
		});
	}
	const boundaries = rubyBoundaries(projection.raw);
	const originalRanges = Array.from(original.values()).sort(
		(a, b) => a.start - b.start,
	);
	// Reverse offsets keep untouched portions of each Text valid while splitting.
	for (const token of [...tokens].sort((a, b) => b.start - a.start)) {
		const label = rubyLabel(token.surface, token.reading);
		if (!label || token.start < partStart) continue;
		const wholeBegin = boundaries[token.start - partStart];
		const labelStart = token.start - partStart + label.start;
		const begin = boundaries[labelStart];
		const end = boundaries[labelStart + Array.from(label.surface).length];
		const wholeEnd = boundaries[token.end - partStart];
		if (
			wholeBegin === undefined ||
			begin === undefined ||
			end === undefined ||
			wholeEnd === undefined ||
			end <= begin
		)
			continue;
		const originalRange =
			originalRanges[firstAfter(originalRanges, wholeBegin, (r) => r.end)];
		if (originalRange && originalRange.start < wholeEnd) continue;
		const entry =
			projection.entries[
				firstAfter(projection.entries, wholeBegin, (e) => e.end)
			];
		if (entry && entry.end < wholeEnd) continue;
		if (
			!entry ||
			entry.node.parentElement?.closest("ruby") ||
			!entry.node.isConnected
		)
			continue;
		const local = begin - entry.start;
		if (
			entry.node.data
				.slice(wholeBegin - entry.start, wholeEnd - entry.start)
				.normalize("NFC") !== token.surface
		)
			continue;
		if (end - entry.start > entry.node.length) continue;
		const text = entry.node.splitText(local);
		text.splitText(end - begin);
		const ruby = doc.createElement("ruby");
		ruby.dataset.autoRuby = "";
		text.replaceWith(ruby);
		ruby.append(text);
		const rt = doc.createElement("rt");
		rt.textContent = label.reading;
		ruby.append(rt);
		created.push(ruby, rt);
	}
	if (
		created.length &&
		savedSelection &&
		selection &&
		("raw" in savedSelection.anchor || "raw" in savedSelection.focus)
	) {
		const leafStart = Number(
			doc.querySelectorAll<HTMLElement>("[data-locator-leaf]")[0]?.dataset
				.locatorLeaf,
		);
		const fresh = projectPart(doc, projection.raw.normalize("NFC"), leafStart);
		const restoreEndpoint = (
			saved: ReturnType<typeof endpoint>,
		): { node: Node; offset: number } | null => {
			if ("raw" in saved) {
				const entry =
					fresh.entries.find((entry) => entry.end > saved.raw) ??
					fresh.entries.at(-1);
				return entry
					? { node: entry.node, offset: saved.raw - entry.start }
					: null;
			}
			return saved.node ? { node: saved.node, offset: saved.offset } : null;
		};
		const anchor = restoreEndpoint(savedSelection.anchor);
		const focus = restoreEndpoint(savedSelection.focus);
		if (anchor && focus)
			selection.setBaseAndExtent(
				anchor.node,
				anchor.offset,
				focus.node,
				focus.offset,
			);
	}
	return created;
}
