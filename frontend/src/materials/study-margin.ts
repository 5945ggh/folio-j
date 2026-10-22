import type { ScreenAnchor } from "./reader-study.ts";

export type StudyMarginEntry = {
	segmentIds: string[];
	anchor: ScreenAnchor;
	left: number;
	top: number;
};
const size = 44;
const gap = 8;
const overlaps = (a: ScreenAnchor, b: ScreenAnchor) =>
	a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** Buttons occupy measured space outside the viewport; grouping never changes records. */
export function studyMarginEntries(
	marks: readonly { id: string; rects: ScreenAnchor[] }[],
	viewport: ScreenAnchor,
	screen: { width: number; height: number },
	vertical: boolean,
	reserved: readonly ScreenAnchor[],
): StudyMarginEntry[] {
	const candidates: StudyMarginEntry[] = [];
	for (const mark of marks) {
		const rect = mark.rects.find((r) => overlaps(r, viewport));
		if (!rect) continue;
		const anchor = {
			left: Math.max(rect.left, viewport.left),
			right: Math.min(rect.right, viewport.right),
			top: Math.max(rect.top, viewport.top),
			bottom: Math.min(rect.bottom, viewport.bottom),
		};
		const left = vertical
			? Math.max(viewport.left, Math.min(anchor.left, viewport.right - size))
			: viewport.right + gap + size <= screen.width
				? viewport.right + gap
				: viewport.left - gap - size;
		const top = vertical
			? viewport.bottom + gap
			: Math.max(viewport.top, Math.min(anchor.top, viewport.bottom - size));
		const button = { left, top, right: left + size, bottom: top + size };
		if (
			left < gap ||
			top < gap ||
			button.right > screen.width - gap ||
			button.bottom > screen.height - gap ||
			overlaps(button, viewport) ||
			reserved.some((r) => overlaps(button, r))
		)
			continue;
		candidates.push({ segmentIds: [mark.id], anchor, left, top });
	}
	candidates.sort((a, b) => (vertical ? a.left - b.left : a.top - b.top));
	const groups: StudyMarginEntry[] = [];
	for (const entry of candidates) {
		const group = groups.at(-1);
		if (
			group &&
			(vertical ? entry.left - group.left : entry.top - group.top) < size + gap
		) {
			group.segmentIds.push(...entry.segmentIds);
		} else groups.push(entry);
	}
	return groups;
}
