import assert from "node:assert/strict";
import test from "node:test";
import {
	bookUiKey,
	DEFAULT_BOOK_UI,
	DEFAULT_DICTIONARY_OPACITY,
	DEFAULT_READER_UI,
	normalizeBookUi,
	normalizeReaderUi,
	READER_UI_KEY,
	readBookUiPreferences,
	readReaderUiPreferences,
	resolveReaderTheme,
	writeReaderUiPreferences,
} from "./preferences.ts";

test("shared floating surfaces retain saved dictionary opacity and validate its supported range", () => {
	const values = new Map([
		[
			READER_UI_KEY,
			JSON.stringify({ dictionaryOpacity: 35, toolbarOpacity: 60 }),
		],
	]);
	const store = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
	};
	assert.equal(readReaderUiPreferences(store).dictionaryOpacity, 35);
	for (const value of [20, 72, 100]) {
		writeReaderUiPreferences(
			{ ...readReaderUiPreferences(store), dictionaryOpacity: value },
			store,
		);
		assert.equal(
			readReaderUiPreferences(store).dictionaryOpacity ??
				DEFAULT_DICTIONARY_OPACITY,
			value,
		);
		assert.equal(readReaderUiPreferences(store).toolbarOpacity, 60);
	}
	for (const value of [19, 101, Number.NaN, "20"]) {
		assert.equal(
			normalizeReaderUi({ dictionaryOpacity: value }).dictionaryOpacity ??
				DEFAULT_DICTIONARY_OPACITY,
			72,
		);
	}
});

test("UI preferences validate enums and bounded values without adding API settings", () => {
	assert.deepEqual(normalizeReaderUi({ theme: "soft", focus: false }), {
		theme: "white",
		focus: false,
		toolbarOpacity: DEFAULT_READER_UI.toolbarOpacity,
		marks: { studySegmentUnderlines: true, studySegmentMargins: true },
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

test("toolbar opacity validates the full range and converts legacy transparency values", () => {
	assert.equal(
		normalizeReaderUi({ theme: "white", focus: false }).toolbarOpacity,
		DEFAULT_READER_UI.toolbarOpacity,
	);
	for (const toolbarOpacity of [0, 20, 55, 100]) {
		assert.equal(
			normalizeReaderUi({ toolbarOpacity }).toolbarOpacity,
			toolbarOpacity,
		);
	}
	for (const toolbarOpacity of [-1, 101, NaN, Infinity, "20", null]) {
		assert.equal(
			normalizeReaderUi({ toolbarOpacity }).toolbarOpacity,
			DEFAULT_READER_UI.toolbarOpacity,
		);
	}
	// Legacy toolbarTransparency stored 100 − opacity on the same 0–100 scale.
	for (const [legacy, expected] of [
		[0, 100],
		[20, 80],
		[55, 45],
		[100, 0],
	]) {
		assert.equal(
			normalizeReaderUi({ toolbarTransparency: legacy }).toolbarOpacity,
			expected,
		);
	}
	assert.equal(
		normalizeReaderUi({ toolbarOpacity: 30, toolbarTransparency: 90 })
			.toolbarOpacity,
		30,
	);
});

test("toolbar opacity persists with cross-book UI preferences and resets to defaults", () => {
	const values = new Map<string, string>();
	const store = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
	};
	const preference = { ...DEFAULT_READER_UI, toolbarOpacity: 65 };
	assert.equal(writeReaderUiPreferences(preference, store), true);
	assert.deepEqual(readReaderUiPreferences(store), preference);
	assert.deepEqual(readBookUiPreferences("a", "v", store), DEFAULT_BOOK_UI);
	assert.equal(writeReaderUiPreferences(DEFAULT_READER_UI, store), true);
	assert.deepEqual(readReaderUiPreferences(store), DEFAULT_READER_UI);
});

test("study marks default on for old preferences and persist across books without changing book preferences", () => {
	const values = new Map<string, string>();
	const store = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
	};
	assert.deepEqual(normalizeReaderUi({ theme: "black" }).marks, {
		studySegmentUnderlines: true,
		studySegmentMargins: true,
	});
	for (const marks of [
		null,
		[],
		true,
		{ studySegments: "false" },
		{ studySegments: 0 },
	])
		assert.deepEqual(normalizeReaderUi({ marks }).marks, {
			studySegmentUnderlines: true,
			studySegmentMargins: true,
		});
	const hidden = {
		...DEFAULT_READER_UI,
		marks: { studySegmentUnderlines: false, studySegmentMargins: false },
	};
	assert.equal(writeReaderUiPreferences(hidden, store), true);
	assert.equal(
		readReaderUiPreferences(store).marks.studySegmentUnderlines,
		false,
	);
	assert.deepEqual(
		readBookUiPreferences("first", "v1", store),
		DEFAULT_BOOK_UI,
	);
	assert.deepEqual(
		readBookUiPreferences("second", "v2", store),
		DEFAULT_BOOK_UI,
	);
	assert.equal(writeReaderUiPreferences(DEFAULT_READER_UI, store), true);
	assert.equal(
		readReaderUiPreferences(store).marks.studySegmentUnderlines,
		true,
	);
});

test("legacy hidden preference upgrades both controls without revealing hidden marks", () => {
	for (const legacy of [false, true]) {
		assert.deepEqual(
			normalizeReaderUi({ marks: { studySegments: legacy } }).marks,
			{ studySegmentUnderlines: legacy, studySegmentMargins: legacy },
		);
		assert.deepEqual(
			normalizeReaderUi({
				marks: { studySegments: legacy, studySegmentMargins: !legacy },
			}).marks,
			{ studySegmentUnderlines: legacy, studySegmentMargins: !legacy },
		);
		assert.deepEqual(
			normalizeReaderUi({
				marks: { studySegments: legacy, studySegmentUnderlines: !legacy },
			}).marks,
			{ studySegmentUnderlines: !legacy, studySegmentMargins: legacy },
		);
	}
	assert.deepEqual(
		normalizeReaderUi({
			marks: { studySegmentUnderlines: false, studySegmentMargins: true },
		}).marks,
		{ studySegmentUnderlines: false, studySegmentMargins: true },
	);
});
