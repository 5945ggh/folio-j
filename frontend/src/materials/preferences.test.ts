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
		writeReaderUiPreferences({ theme: "black", focus: false }, broken),
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
