import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONTEXT_COPY } from "./context-copy.ts";
import { DEFAULT_BOOK_UI, DEFAULT_READER_UI } from "./preferences.ts";
import {
	contextCopySummary,
	DEFAULT_READER_SETTINGS_EXPANDED,
	DEFAULT_READING_SETTINGS,
	restoreReaderSettingsGroup,
	typographySummary,
} from "./reader-settings.ts";

test("each reset only returns fields owned by its group", () => {
	assert.deepEqual(restoreReaderSettingsGroup("typography"), {
		settings: {
			font_size: 22,
			line_height: 2.4,
			writing_mode: "horizontal-tb",
		},
		bookUi: { font: "mincho", width: 760 },
	});
	assert.deepEqual(restoreReaderSettingsGroup("ruby"), {
		bookUi: { ruby: "show", rubyScope: "original" },
	});
	assert.deepEqual(restoreReaderSettingsGroup("interface"), {
		ui: {
			theme: DEFAULT_READER_UI.theme,
			toolbarOpacity: DEFAULT_READER_UI.toolbarOpacity,
			marks: DEFAULT_READER_UI.marks,
		},
	});
	const currentUi = { ...DEFAULT_READER_UI, focus: false, toolbarOpacity: 30 };
	const resetUi = {
		...currentUi,
		...restoreReaderSettingsGroup("interface").ui,
	};
	assert.equal(resetUi.focus, false);
	assert.equal(resetUi.toolbarOpacity, DEFAULT_READER_UI.toolbarOpacity);
	const typography = restoreReaderSettingsGroup("typography");
	const currentBook = { ...DEFAULT_BOOK_UI, ruby: "hide", rubyScope: "all" };
	assert.deepEqual({ ...currentBook, ...typography.bookUi }, currentBook);
	const ruby = restoreReaderSettingsGroup("ruby");
	const customLayout = { ...DEFAULT_BOOK_UI, font: "gothic", width: 1040 };
	assert.deepEqual({ ...customLayout, ...ruby.bookUi }, customLayout);
});

test("reset objects do not expose shared mutable defaults", () => {
	const patch = restoreReaderSettingsGroup("interface");
	assert.ok(patch.ui?.marks);
	patch.ui.marks.studySegmentMargins = false;
	assert.equal(DEFAULT_READER_UI.marks.studySegmentMargins, true);
	const typography = restoreReaderSettingsGroup("typography");
	assert.ok(typography.settings);
	typography.settings.font_size = 39;
	assert.equal(DEFAULT_READING_SETTINGS.font_size, 22);
});

test("copy summary reports the saved side as absent when either budget is zero", () => {
	assert.equal(
		contextCopySummary(DEFAULT_CONTEXT_COPY),
		"前 3 句 · 不附后文 · 附出处",
	);
	assert.equal(
		contextCopySummary({
			...DEFAULT_CONTEXT_COPY,
			before_characters: 0,
			after_sentences: 5,
			after_characters: 0,
			include_source: false,
		}),
		"不附前文 · 不附后文 · 不附出处",
	);
	assert.equal(
		contextCopySummary({
			...DEFAULT_CONTEXT_COPY,
			before_sentences: 0,
			after_sentences: 1,
		}),
		"不附前文 · 后 1 句 · 附出处",
	);
});

test("vertical typography summary does not imply stored width is active", () => {
	assert.equal(
		typographySummary(DEFAULT_READING_SETTINGS, DEFAULT_BOOK_UI),
		"明朝体 · 行距 2.4 · 宽度 760",
	);
	assert.equal(
		typographySummary(
			{ ...DEFAULT_READING_SETTINGS, writing_mode: "vertical-rl" },
			{ ...DEFAULT_BOOK_UI, font: "gothic", width: 1040 },
		),
		"黑体 · 行距 2.4 · 宽度仅用于横排",
	);
});

test("reading settings start with every secondary control and help folded", () => {
	assert.equal(Object.values(DEFAULT_READER_SETTINGS_EXPANDED).length, 7);
	assert.equal(
		Object.values(DEFAULT_READER_SETTINGS_EXPANDED).every(
			(open) => open === false,
		),
		true,
	);
});
