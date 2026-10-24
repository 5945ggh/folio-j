import type { ScreenAnchor } from "../materials/reader-study";

export type AnchorPlacement =
	| "text"
	| "margin-left"
	| "margin-right"
	| "margin-bottom";

/** Place short reading help beside its target, reserving the reader's playback/navigation area. */
export function translationCardPosition(
	anchor: ScreenAnchor | null,
	viewport: { width: number; height: number },
	size: { width: number; height: number },
	direction: "horizontal-tb" | "vertical-rl" = "horizontal-tb",
	bottomInset = 76,
	anchorPlacement: AnchorPlacement = "text",
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
		anchor.bottom <= (anchorPlacement === "text" ? ceiling : 0) ||
		anchor.top >= (anchorPlacement === "text" ? floor : viewport.height)
	)
		return {
			left: right,
			top: ceiling + Math.min(18, maxHeight - height),
			maxHeight: maxHeight - Math.min(18, maxHeight - height),
		};
	const leftSpace = anchor.left - margin - 8;
	const rightSpace = viewport.width - margin - anchor.right - 8;
	const side = (preferRight = false) => {
		if (preferRight && rightSpace >= size.width)
			return { left: anchor.right + 8, top: clampTop(anchor.top), maxHeight };
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
	if (
		anchorPlacement === "margin-left" ||
		anchorPlacement === "margin-right" ||
		(anchorPlacement === "text" && direction === "vertical-rl")
	) {
		const beside = side(anchorPlacement === "margin-right");
		if (beside) return beside;
	}
	const belowEdge = Math.max(ceiling, anchor.bottom + 8);
	const aboveEdge = Math.min(floor, anchor.top - 8);
	const below = Math.max(0, floor - belowEdge);
	const above = Math.max(0, aboveEdge - ceiling);
	const useBelow =
		anchorPlacement === "margin-bottom"
			? above < Math.min(height, 180) && below > above
			: below >= Math.min(height, 240) || below >= above;
	const available = useBelow ? below : above;
	if (available >= Math.min(height, 180)) {
		const limit = Math.min(maxHeight, available);
		return {
			left: clampLeft((anchor.left + anchor.right - size.width) / 2),
			top: useBelow ? belowEdge : aboveEdge - Math.min(size.height, limit),
			maxHeight: limit,
		};
	}
	return side() ?? { left: right, top: ceiling, maxHeight };
}
