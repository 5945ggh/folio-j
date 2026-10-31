/** Keep a top-layer detail beside the navigation panel when it has room. */
export function bookmarkDetailPosition(
	panel: { right: number; top: number },
	viewport: { width: number; height: number },
): { left: number; top: number; width: number; maxHeight: number } {
	const gap = 12;
	const available = viewport.width - panel.right - gap * 2;
	const adjacent = viewport.width >= 720 && available >= 300;
	const width = Math.max(
		0,
		Math.min(adjacent ? available : viewport.width - gap * 2, 420),
	);
	const top = Math.max(gap, Math.min(panel.top, viewport.height - 240));
	return {
		left: adjacent
			? panel.right + gap
			: Math.max(gap, (viewport.width - width) / 2),
		top,
		width,
		maxHeight: Math.max(0, viewport.height - top - gap),
	};
}
