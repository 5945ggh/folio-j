export const MIN_SOURCE_DIRECTORY_WIDTH = 220;
export const MAX_SOURCE_DIRECTORY_WIDTH = 360;
export const DEFAULT_SOURCE_DIRECTORY_WIDTH = 260;

export function sourceDirectoryWidth(value: string | number): number {
	if (typeof value === "string" && !value.trim())
		return DEFAULT_SOURCE_DIRECTORY_WIDTH;
	const width = Number(value);
	if (!Number.isFinite(width)) return DEFAULT_SOURCE_DIRECTORY_WIDTH;
	return Math.round(
		Math.min(
			MAX_SOURCE_DIRECTORY_WIDTH,
			Math.max(MIN_SOURCE_DIRECTORY_WIDTH, width),
		),
	);
}
