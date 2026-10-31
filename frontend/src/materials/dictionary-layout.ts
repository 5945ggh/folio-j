import {
	clampReaderCardPosition,
	type ReaderCardPosition,
} from "./reader-card-drag.ts";
import type { ScreenAnchor } from "./reader-study.ts";

export const compactDictionaryWidth = 740;
const gap = 8;
const clamp = (value: number, first: number, last: number) =>
	Math.max(first, Math.min(value, last));

/** Keep the whole visible card on screen while dragging, and its header reachable after resizing. */
export function movedDictionaryLayout(
	point: ReaderCardPosition,
	cardWidth: number,
	viewport: { width: number; height: number },
	compact: boolean,
	keepHeight = 120,
) {
	const inset = compact ? 10 : 12;
	const { left, top } = clampReaderCardPosition(
		point,
		{
			left: inset,
			right: viewport.width - inset - cardWidth,
			top: inset,
			bottom: viewport.height - inset,
		},
		keepHeight,
	);
	const available = Math.max(0, viewport.height - inset - top);
	return {
		left,
		top,
		width: cardWidth,
		maxHeight: compact ? available : Math.min(460, available),
	};
}

export function compactDictionaryLayout(
	anchor: ScreenAnchor,
	width: number,
	height: number,
) {
	const inset = 10;
	const cardWidth = Math.min(440, width - inset * 2);
	const below = height - inset - anchor.bottom - gap;
	const above = anchor.top - inset - gap;
	const placeAbove = below < Math.min(height * 0.46, 340) && above > below;
	const edge = Math.max(
		inset,
		placeAbove ? height - anchor.top + gap : anchor.bottom + gap,
	);
	const limit = Math.max(100, height - edge - inset);
	return {
		left: (width - cardWidth) / 2,
		width: cardWidth,
		top: placeAbove
			? Math.max(inset, height - edge - Math.min(460, limit))
			: edge,
		maxHeight: placeAbove ? Math.min(460, limit) : limit,
	};
}

const intersection = (a: ScreenAnchor, b: ScreenAnchor) =>
	Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
	Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

/** Keep the top edge fixed across pages. Favor space beside the parent, then free space around the selected glyph. */
export function desktopDictionaryLayout(
	anchor: ScreenAnchor,
	parents: ScreenAnchor[],
	width: number,
	height: number,
	firstPageHeight: number,
) {
	const inset = 12;
	const cardWidth = Math.min(388, (width - 2 * inset - gap) / 2);
	const maxHeight = Math.min(460, height - 2 * inset);
	const measured = Math.min(firstPageHeight, maxHeight);
	const x = (v: number) => clamp(v, inset, width - cardWidth - inset);
	const y = (v: number) => clamp(v, inset, height - measured - inset);
	const parent = parents.at(-1);
	if (!parent) {
		const below = height - inset - anchor.bottom - gap;
		const openAbove =
			below < Math.min(measured, 270) && anchor.top - inset - gap > below;
		const top = openAbove
			? y(anchor.top - gap - measured)
			: clamp(anchor.bottom + gap, inset, height - inset - 100);
		return {
			left: x(anchor.left - 16),
			top,
			width: cardWidth,
			maxHeight: Math.min(maxHeight, height - inset - top),
		};
	}
	const sideY = y(anchor.top - 26);
	const candidates = [
		[x(parent.right + gap), sideY],
		[x(parent.left - cardWidth - gap), sideY],
		[x(anchor.left - 18), y(parent.top - gap - measured)],
		[x(anchor.left - 18), y(parent.bottom + gap)],
		[x(anchor.left - 18), y(anchor.bottom + gap)],
		[x(anchor.left - 18), y(anchor.top - measured - gap)],
		[x(anchor.right + gap), sideY],
		[x(anchor.left - cardWidth - gap), sideY],
	] as const;
	let best = candidates[0] as readonly [number, number],
		bestScore = Infinity;
	for (const [left, top] of candidates) {
		const box = { left, top, right: left + cardWidth, bottom: top + measured };
		const cost = parents.reduce(
			(sum, old) =>
				sum +
				intersection(box, old) +
				2 *
					intersection(box, {
						left: old.left,
						right: old.right,
						top: old.top,
						bottom: Math.min(old.bottom, old.top + 52),
					}),
			0,
		);
		const score =
			cost +
			(intersection(box, anchor) > 0
				? width * height * (parents.length + 1)
				: 0);
		if (score < bestScore) {
			best = [left, top];
			bestScore = score;
		}
	}
	return {
		left: best[0],
		top: best[1],
		width: cardWidth,
		maxHeight: Math.min(maxHeight, height - inset - best[1]),
	};
}
