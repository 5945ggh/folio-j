export type ReaderCardPosition = { left: number; top: number };
export type ReaderCardBounds = {
	left: number;
	right: number;
	top: number;
	bottom: number;
};
export type ReaderCardDragStart = ReaderCardPosition & { x: number; y: number };

export function clampReaderCardPosition(
	position: ReaderCardPosition,
	bounds: ReaderCardBounds,
	height: number,
): ReaderCardPosition {
	return {
		left: Math.max(bounds.left, Math.min(bounds.right, position.left)),
		top: Math.max(
			bounds.top,
			Math.min(
				bounds.bottom - Math.min(height, bounds.bottom - bounds.top),
				position.top,
			),
		),
	};
}

export function readerCardDragPosition(
	start: ReaderCardDragStart,
	pointer: { x: number; y: number },
	dragging: boolean,
): ReaderCardPosition | null {
	const x = pointer.x - start.x;
	const y = pointer.y - start.y;
	if (!dragging && Math.hypot(x, y) < 5) return null;
	return { left: start.left + x, top: start.top + y };
}

export function readerCardKeyPosition(
	position: ReaderCardPosition,
	key: string,
	shift: boolean,
): ReaderCardPosition | null {
	const step = shift ? 40 : 10;
	switch (key) {
		case "ArrowLeft":
			return { ...position, left: position.left - step };
		case "ArrowRight":
			return { ...position, left: position.left + step };
		case "ArrowUp":
			return { ...position, top: position.top - step };
		case "ArrowDown":
			return { ...position, top: position.top + step };
		default:
			return null;
	}
}
