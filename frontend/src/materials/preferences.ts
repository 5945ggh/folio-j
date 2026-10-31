export type ReaderTheme = "system" | "white" | "black";
export type ReaderFont = "mincho" | "gothic";
export type ReaderRuby = "show" | "on-demand" | "hide";
export const DEFAULT_DICTIONARY_OPACITY = 72;
export const MIN_DICTIONARY_OPACITY = 20;
export type ReaderUiPreferences = {
	dictionaryOpacity?: number;
	dictionaryMode?: "off" | "click" | "hover";
	theme: ReaderTheme;
	focus: boolean;
	toolbarOpacity: number;
	marks: { studySegmentUnderlines: boolean; studySegmentMargins: boolean };
};
export type BookUiPreferences = {
	font: ReaderFont;
	ruby: ReaderRuby;
	rubyScope?: "original" | "all";
	width: number;
};
export const DEFAULT_READER_UI: ReaderUiPreferences = {
	theme: "system",
	focus: true,
	toolbarOpacity: 80,
	marks: { studySegmentUnderlines: true, studySegmentMargins: true },
};
export const DEFAULT_BOOK_UI: BookUiPreferences = {
	font: "mincho",
	ruby: "show",
	rubyScope: "original",
	width: 760,
};
export const READER_UI_KEY = "folio-reader-ui-v1";
export const bookUiKey = (materialId: string, versionId: string) =>
	`folio-reader-book-ui-v1:${encodeURIComponent(materialId)}:${encodeURIComponent(versionId)}`;
export type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;
function storage(): PreferenceStorage | undefined {
	try {
		return globalThis.localStorage;
	} catch {
		return undefined;
	}
}
function load(
	key: string,
	store: PreferenceStorage | undefined,
): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(store?.getItem(key) ?? "null");
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}
const boundedPercent = (input: unknown): number | null =>
	typeof input === "number" &&
	Number.isFinite(input) &&
	input >= 0 &&
	input <= 100
		? input
		: null;
export function normalizeReaderUi(
	value: Record<string, unknown>,
): ReaderUiPreferences {
	const marks =
		value.marks &&
		typeof value.marks === "object" &&
		!Array.isArray(value.marks)
			? (value.marks as Record<string, unknown>)
			: {};
	// toolbarOpacity replaced toolbarTransparency on the same 0–100 scale, inverted.
	const legacyTransparency = boundedPercent(value.toolbarTransparency);
	const opacity = boundedPercent(value.dictionaryOpacity);
	return {
		...(opacity !== null &&
		opacity >= MIN_DICTIONARY_OPACITY &&
		opacity !== DEFAULT_DICTIONARY_OPACITY
			? { dictionaryOpacity: Math.round(opacity) }
			: {}),
		...(value.dictionaryMode === "click" || value.dictionaryMode === "hover"
			? { dictionaryMode: value.dictionaryMode }
			: {}),
		marks: {
			studySegmentUnderlines:
				typeof marks.studySegmentUnderlines === "boolean"
					? marks.studySegmentUnderlines
					: typeof marks.studySegments === "boolean"
						? marks.studySegments
						: true,
			studySegmentMargins:
				typeof marks.studySegmentMargins === "boolean"
					? marks.studySegmentMargins
					: typeof marks.studySegments === "boolean"
						? marks.studySegments
						: true,
		},
		theme:
			value.theme === "black"
				? "black"
				: value.theme === "white" || value.theme === "soft"
					? "white"
					: "system",
		focus: typeof value.focus === "boolean" ? value.focus : true,
		toolbarOpacity:
			boundedPercent(value.toolbarOpacity) ??
			(legacyTransparency !== null
				? 100 - legacyTransparency
				: DEFAULT_READER_UI.toolbarOpacity),
	};
}
export function normalizeBookUi(
	value: Record<string, unknown>,
): BookUiPreferences {
	return {
		font: value.font === "gothic" ? "gothic" : "mincho",
		ruby:
			value.ruby === "show" ||
			value.ruby === "hide" ||
			value.ruby === "on-demand"
				? value.ruby
				: "show",
		rubyScope: value.rubyScope === "all" ? "all" : "original",
		width:
			typeof value.width === "number" &&
			Number.isFinite(value.width) &&
			value.width >= 560 &&
			value.width <= 1040
				? value.width
				: 760,
	};
}
export function readReaderUiPreferences(
	store = storage(),
): ReaderUiPreferences {
	return normalizeReaderUi(load(READER_UI_KEY, store));
}
export function readBookUiPreferences(
	materialId: string,
	versionId: string,
	store = storage(),
): BookUiPreferences {
	return normalizeBookUi(load(bookUiKey(materialId, versionId), store));
}
function save(
	key: string,
	value: unknown,
	store: PreferenceStorage | undefined,
): boolean {
	try {
		if (!store) return false;
		store.setItem(key, JSON.stringify(value));
		return true;
	} catch {
		return false;
	}
}
export function writeReaderUiPreferences(
	value: ReaderUiPreferences,
	store = storage(),
): boolean {
	return save(READER_UI_KEY, normalizeReaderUi(value), store);
}
export function writeBookUiPreferences(
	materialId: string,
	versionId: string,
	value: BookUiPreferences,
	store = storage(),
): boolean {
	return save(bookUiKey(materialId, versionId), normalizeBookUi(value), store);
}
export function resolveReaderTheme(
	theme: ReaderTheme,
	systemDark: boolean,
): "white" | "black" {
	return theme === "system" ? (systemDark ? "black" : "white") : theme;
}
