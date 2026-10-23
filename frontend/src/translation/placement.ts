import type { ScreenAnchor } from "../materials/reader-study";

/** Place short reading help beside its target, reserving the reader's playback/navigation area. */
export function translationCardPosition(
	anchor: ScreenAnchor | null,
	viewport: { width: number; height: number },
	size: { width: number; height: number },
	direction: "horizontal-tb" | "vertical-rl" = "horizontal-tb",
	bottomInset = 76,
) {
	const margin = 12;
	const ceiling = viewport.height < 500 ? margin : 64;
	const floor = Math.max(ceiling, viewport.height - bottomInset);
	const maxHeight = Math.min(520, floor - ceiling);
	const height = Math.min(size.height, maxHeight);
	const right = Math.max(margin, viewport.width - size.width - margin);
	const clampLeft = (left: number) => Math.max(margin, Math.min(right, left));
	const clampTop = (top: number) =>
		Math.max(ceiling, Math.min(floor - height, top));
	if (viewport.width <= 600) {
		const limit = Math.min(maxHeight, viewport.height * 0.6);
		return {
			left: margin,
			top: floor - Math.min(size.height, limit),
			maxHeight: limit,
		};
	}
	if (
		!anchor ||
		anchor.right <= 0 ||
		anchor.left >= viewport.width ||
		anchor.bottom <= ceiling ||
		anchor.top >= floor
	)
		return {
			left: right,
			top: ceiling + Math.min(18, maxHeight - height),
			maxHeight: maxHeight - Math.min(18, maxHeight - height),
		};
	const leftSpace = anchor.left - margin - 8;
	const rightSpace = viewport.width - margin - anchor.right - 8;
	const side = () => {
		if (leftSpace >= size.width)
			return {
				left: anchor.left - size.width - 8,
				top: clampTop(anchor.top),
				maxHeight,
			};
		if (rightSpace >= size.width)
			return { left: anchor.right + 8, top: clampTop(anchor.top), maxHeight };
		return null;
	};
	if (direction === "vertical-rl") {
		const beside = side();
		if (beside) return beside;
	}
	const below = Math.max(0, floor - anchor.bottom - 8);
	const above = Math.max(0, anchor.top - ceiling - 8);
	const useBelow = below >= Math.min(height, 240) || below >= above;
	const available = useBelow ? below : above;
	if (available >= Math.min(height, 180)) {
		const limit = Math.min(maxHeight, available);
		return {
			left: clampLeft((anchor.left + anchor.right - size.width) / 2),
			top: useBelow
				? anchor.bottom + 8
				: anchor.top - 8 - Math.min(size.height, limit),
			maxHeight: limit,
		};
	}
	return side() ?? { left: right, top: ceiling, maxHeight };
}
