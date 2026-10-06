import assert from "node:assert/strict";
import test from "node:test";
import {
	bookUiKey,
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
	assert.deepEqual(normalizeReaderUi({ theme: "unknown", focus: 0 }), {
		theme: "system",
		focus: true,
	});
	assert.deepEqual(
		normalizeBookUi({
			font: "gothic",
			ruby: "on-demand",
			width: 1040,
			font_size: 40,
		}),
		{ font: "gothic", ruby: "on-demand", width: 1040 },
	);
	for (const width of [559, 1041, NaN, Infinity, "760"])
		assert.equal(normalizeBookUi({ width }).width, 760);
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
	assert.equal(readReaderUiPreferences(broken).focus, true);
	assert.equal(readBookUiPreferences("a", "v", broken).width, 760);
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
	assert.equal(readReaderUiPreferences(inaccessible).theme, "system");
});
