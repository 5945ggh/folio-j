import assert from "node:assert/strict";
import test from "node:test";
import {
	bookUiKey,
	DEFAULT_BOOK_UI,
	DEFAULT_READER_UI,
	normalizeBookUi,
	normalizeReaderUi,
	readBookUiPreferences,
	readReaderUiPreferences,
	resolveReaderTheme,
	writeReaderUiPreferences,
} from "./preferences.ts";

test("UI preferences validate enums and bounded values without adding API settings", () => {
	assert.deepEqual(normalizeReaderUi({ theme: "soft", focus: false }), {
		theme: "white",
		focus: false,
		toolbarTransparency: DEFAULT_READER_UI.toolbarTransparency,
	});
	assert.deepEqual(
		normalizeReaderUi({ theme: "unknown", focus: 0 }),
		DEFAULT_READER_UI,
	);
	assert.deepEqual(
		normalizeBookUi({
			font: "gothic",
			ruby: "on-demand",
			width: 1040,
			font_size: 40,
		}),
		{ font: "gothic", ruby: "on-demand", rubyScope: "original", width: 1040 },
	);
	assert.equal(normalizeBookUi({ width: 560 }).width, 560);
	assert.deepEqual(
		normalizeBookUi({ font: "unknown", ruby: "unknown" }),
		DEFAULT_BOOK_UI,
	);
	for (const width of [559, 1041, NaN, Infinity, "760"])
		assert.equal(normalizeBookUi({ width }).width, DEFAULT_BOOK_UI.width);
	assert.equal(resolveReaderTheme("system", true), "black");
	assert.equal(resolveReaderTheme("white", true), "white");
	assert.notEqual(bookUiKey("a:b", "c"), bookUiKey("a", "b:c"));
});
test("broken or inaccessible browser storage does not block reading", () => {
	const broken = {
		getItem: () => "{",
		setItem: () => {
			throw new Error("quota");
		},
	};
	assert.deepEqual(readReaderUiPreferences(broken), DEFAULT_READER_UI);
	assert.deepEqual(readBookUiPreferences("a", "v", broken), DEFAULT_BOOK_UI);
	assert.equal(
		writeReaderUiPreferences(
			{ ...DEFAULT_READER_UI, theme: "black", focus: false },
			broken,
		),
		false,
	);
	const inaccessible = {
		getItem: () => {
			throw new Error("security");
		},
		setItem: () => {},
	};
	assert.deepEqual(readReaderUiPreferences(inaccessible), DEFAULT_READER_UI);
});

test("toolbar transparency restores legacy defaults and validates the full range", () => {
	assert.equal(
		normalizeReaderUi({ theme: "white", focus: false }).toolbarTransparency,
		DEFAULT_READER_UI.toolbarTransparency,
	);
	for (const toolbarTransparency of [0, 20, 55, 100]) {
		assert.equal(
			normalizeReaderUi({ toolbarTransparency }).toolbarTransparency,
			toolbarTransparency,
		);
	}
	for (const toolbarTransparency of [-1, 101, NaN, Infinity, "20", null]) {
		assert.equal(
			normalizeReaderUi({ toolbarTransparency }).toolbarTransparency,
			DEFAULT_READER_UI.toolbarTransparency,
		);
	}
});

test("toolbar transparency persists with cross-book UI preferences and resets to defaults", () => {
	const values = new Map<string, string>();
	const store = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
	};
	const preference = { ...DEFAULT_READER_UI, toolbarTransparency: 65 };
	assert.equal(writeReaderUiPreferences(preference, store), true);
	assert.deepEqual(readReaderUiPreferences(store), preference);
	assert.deepEqual(readBookUiPreferences("a", "v", store), DEFAULT_BOOK_UI);
	assert.equal(writeReaderUiPreferences(DEFAULT_READER_UI, store), true);
	assert.deepEqual(readReaderUiPreferences(store), DEFAULT_READER_UI);
});
