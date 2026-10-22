import type { ScreenAnchor } from "./reader-study";

/** Keep anchored tools inside the visible reading area in either writing direction. */
export function studyOverlayPosition(
	anchor: ScreenAnchor,
	viewport: { width: number; height: number },
	size: { width: number; height: number },
) {
	const margin = 12;
	const left = Math.max(
		margin,
		Math.min(
			viewport.width - size.width - margin,
			(anchor.left + anchor.right - size.width) / 2,
		),
	);
	const below = anchor.bottom + 8;
	const top =
		below + size.height <= viewport.height - 76
			? below
			: anchor.top - size.height - 8;
	return {
		left,
		top: Math.max(64, Math.min(viewport.height - size.height - margin, top)),
	};
}

/** Content cards use the larger free vertical space without covering their target. */
export function studyPreviewPosition(
	anchor: ScreenAnchor,
	viewport: { width: number; height: number },
	size: { width: number; height: number },
) {
	const margin = 12;
	const ceiling = 64;
	const floor = Math.max(ceiling + 80, viewport.height - 76);
	const below = Math.max(0, floor - anchor.bottom - 8);
	const above = Math.max(0, anchor.top - 8 - ceiling);
	const useBelow = below >= Math.min(size.height, 240) || below >= above;
	const available = useBelow ? below : above;
	const maxHeight = Math.min(420, Math.max(80, available));
	const height = Math.min(size.height, maxHeight);
	return {
		left: Math.max(
			margin,
			Math.min(
				viewport.width - size.width - margin,
				(anchor.left + anchor.right - size.width) / 2,
			),
		),
		top: Math.max(
			ceiling,
			Math.min(
				floor - height,
				useBelow ? anchor.bottom + 8 : anchor.top - height - 8,
			),
		),
		maxHeight,
	};
}

export function nativeSelectionKey(
	event: Pick<KeyboardEvent, "key" | "shiftKey">,
) {
	return (
		event.shiftKey &&
		/^(Arrow(?:Left|Right|Up|Down)|Home|End|PageUp|PageDown)$/.test(event.key)
	);
}
