import type { ScreenAnchor } from "./reader-study.ts";

export function dictionaryLayout(
	anchor: ScreenAnchor,
	width: number,
	height: number,
	depth: number,
) {
	const inset = width < 740 ? 10 : 18;
	const compact = width < 740;
	const columns = compact || depth === 1 ? 1 : 2;
	const cardWidth = Math.min(
		compact ? 440 : 380,
		(width - inset * 2 - (columns - 1) * 8) / columns,
	);
	const deckWidth = cardWidth * columns + (columns - 1) * 8;
	const left = compact
		? (width - deckWidth) / 2
		: Math.max(inset, Math.min(anchor.left - 16, width - inset - deckWidth));
	const availableBelow = height - inset - anchor.bottom - 8;
	const availableAbove = anchor.top - inset - 8;
	const minHeight = Math.min(height * 0.46, 340);
	const above = availableBelow < minHeight && availableAbove > availableBelow;
	const edge = Math.max(
		inset,
		above ? height - anchor.top + 8 : anchor.bottom + 8,
	);
	const limit = Math.max(100, height - edge - inset);
	return {
		left,
		width: deckWidth,
		...(above ? { bottom: edge } : { top: edge }),
		maxHeight: limit,
		compact,
		cardWidth,
		limit,
	};
}
