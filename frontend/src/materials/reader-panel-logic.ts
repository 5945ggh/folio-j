export const READER_QUERY_PAGE_SIZE = 40;
export const READER_SEARCH_DELAY = 200;
export type ReaderPanelKind =
	| "toc"
	| "search"
	| "gallery"
	| "settings"
	| "info";
export type ReaderPanelSide = "left" | "right";
export type ReaderPanelsState = {
	left: "toc" | "search" | null;
	right: "gallery" | "settings" | "info" | null;
	activeSide: ReaderPanelSide | null;
};
export const EMPTY_READER_PANELS: ReaderPanelsState = {
	left: null,
	right: null,
	activeSide: null,
};
export function selectReaderPanel(
	current: ReaderPanelsState,
	next: ReaderPanelKind,
	toggle = false,
	compact = false,
): ReaderPanelsState {
	const navigation = next === "toc" || next === "search";
	const side = navigation ? "left" : "right";
	if (
		compact &&
		toggle &&
		current.activeSide !== side &&
		(current[side] === next || (navigation && current.left !== null))
	)
		return { ...current, activeSide: side };
	if (next === "toc" || next === "search") {
		const left = toggle && current.left !== null ? null : next;
		return {
			...current,
			left,
			activeSide: left ? "left" : current.right ? "right" : null,
		};
	}
	const right = toggle && current.right === next ? null : next;
	return {
		...current,
		right,
		activeSide: right ? "right" : current.left ? "left" : null,
	};
}
export function closeReaderPanel(
	current: ReaderPanelsState,
	side: ReaderPanelSide,
): ReaderPanelsState {
	const other = side === "left" ? "right" : "left";
	return {
		...current,
		[side]: null,
		activeSide: current[other] ? other : null,
	};
}
export function normalizeReaderQuery(value: string): string {
	return value.trim().normalize("NFC");
}
export function readerQueryTooLong(value: string): boolean {
	return Array.from(normalizeReaderQuery(value)).length > 160;
}
export function fitImageSize(
	width: number,
	height: number,
	availableWidth: number,
	availableHeight: number,
	zoom: number,
) {
	const fit = Math.min(
		availableWidth / Math.max(1, width),
		availableHeight / Math.max(1, height),
		1,
	);
	return {
		width: Math.max(1, width * fit * zoom),
		height: Math.max(1, height * fit * zoom),
	};
}
