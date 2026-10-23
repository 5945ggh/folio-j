import type { ScreenAnchor } from "./reader-study.ts";

export type StudyMarginEntry = {
	segmentIds: string[];
	/** ReaderStudy publishes the anchor and offsets in scroll-container content coordinates. */
	anchor: ScreenAnchor;
	left: number;
	top: number;
};
const size = 44;
const gap = 8;
function union(a: ScreenAnchor, b: ScreenAnchor): ScreenAnchor {
	return {
		left: Math.min(a.left, b.left),
		right: Math.max(a.right, b.right),
		top: Math.min(a.top, b.top),
		bottom: Math.max(a.bottom, b.bottom),
	};
}

/** Lay out the complete chapter at stable original anchors; scrolling never changes grouping. */
export function studyMarginEntries(
	marks: readonly { id: string; rects: ScreenAnchor[] }[],
	viewport: ScreenAnchor,
	screen: { width: number; height: number },
	vertical: boolean,
	content: ScreenAnchor,
): StudyMarginEntry[] {
	const candidates: StudyMarginEntry[] = [];
	for (const mark of marks) {
		const rect = mark.rects[0];
		if (!rect) continue;
		const anchor = mark.rects.reduce(union);
		const left = vertical
			? Math.max(content.left, Math.min(rect.left, content.right - size))
			: viewport.right + gap + size <= screen.width
				? viewport.right + gap
				: viewport.left - gap - size;
		const top = vertical
			? viewport.bottom + gap
			: Math.max(content.top, Math.min(rect.top, content.bottom - size));
		// Only the cross axis needs room. Offscreen buttons are clipped by native scrolling.
		if (
			vertical
				? top < gap || top + size > screen.height - gap
				: left < gap || left + size > screen.width - gap
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
			group.anchor = union(group.anchor, entry.anchor);
		} else groups.push(entry);
	}
	return groups;
}
