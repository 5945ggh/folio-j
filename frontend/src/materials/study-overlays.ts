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

export function nativeSelectionKey(
	event: Pick<KeyboardEvent, "key" | "shiftKey">,
) {
	return (
		event.shiftKey &&
		/^(Arrow(?:Left|Right|Up|Down)|Home|End|PageUp|PageDown)$/.test(event.key)
	);
}
