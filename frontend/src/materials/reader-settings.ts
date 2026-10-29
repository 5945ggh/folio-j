import type { ContextCopyPreferences } from "../settings/context-copy-api.ts";
import type { Settings } from "./api.ts";
import {
	type BookUiPreferences,
	DEFAULT_BOOK_UI,
	DEFAULT_READER_UI,
	type ReaderUiPreferences,
} from "./preferences.ts";

export const DEFAULT_READING_SETTINGS: Settings = {
	font_size: 22,
	line_height: 2,
	writing_mode: "horizontal-tb",
};

export type ReaderSettingsGroup = "typography" | "ruby" | "interface";
export type ReaderSettingsExpanded = {
	typography: boolean;
	rubyHelp: boolean;
	interface: boolean;
	interfaceHelp: boolean;
	copy: boolean;
	copyLimits: boolean;
	copyPreview: boolean;
};
export const DEFAULT_READER_SETTINGS_EXPANDED: ReaderSettingsExpanded = {
	typography: false,
	rubyHelp: false,
	interface: false,
	interfaceHelp: false,
	copy: false,
	copyLimits: false,
	copyPreview: false,
};

export type ReaderSettingsPatch = {
	settings?: Partial<Settings>;
	bookUi?: Partial<BookUiPreferences>;
	ui?: Partial<ReaderUiPreferences>;
};

/** Only the requested group's fields are returned, for merging into current state. */
export function restoreReaderSettingsGroup(
	group: ReaderSettingsGroup,
): ReaderSettingsPatch {
	switch (group) {
		case "typography":
			return {
				settings: { ...DEFAULT_READING_SETTINGS },
				bookUi: { font: DEFAULT_BOOK_UI.font, width: DEFAULT_BOOK_UI.width },
			};
		case "ruby":
			return {
				bookUi: {
					ruby: DEFAULT_BOOK_UI.ruby,
					rubyScope: DEFAULT_BOOK_UI.rubyScope,
				},
			};
		case "interface":
			return {
				ui: {
					theme: DEFAULT_READER_UI.theme,
					toolbarOpacity: DEFAULT_READER_UI.toolbarOpacity,
					marks: { ...DEFAULT_READER_UI.marks },
				},
			};
	}
}

export function contextCopySummary(value: ContextCopyPreferences): string {
	const before = value.before_sentences > 0 && value.before_characters > 0;
	const after = value.after_sentences > 0 && value.after_characters > 0;
	return [
		before ? `前 ${value.before_sentences} 句` : "不附前文",
		after ? `后 ${value.after_sentences} 句` : "不附后文",
		value.include_source ? "附出处" : "不附出处",
	].join(" · ");
}

export function typographySummary(
	settings: Settings,
	bookUi: BookUiPreferences,
): string {
	return [
		bookUi.font === "mincho" ? "明朝体" : "黑体",
		`行距 ${settings.line_height.toFixed(1)}`,
		settings.writing_mode === "vertical-rl"
			? "宽度仅用于横排"
			: `宽度 ${bookUi.width}`,
	].join(" · ");
}
