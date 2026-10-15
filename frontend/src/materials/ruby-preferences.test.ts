import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_BOOK_UI, normalizeBookUi } from "./preferences.ts";
import { rubyLabel } from "./ruby.ts";

test("ruby starts with original annotations visible and migrates dim", () => {
	assert.equal(DEFAULT_BOOK_UI.ruby, "show");
	assert.equal(DEFAULT_BOOK_UI.rubyScope, "original");
	assert.equal(normalizeBookUi({ ruby: "dim" }).ruby, "show");
	assert.equal(
		normalizeBookUi({ ruby: "hide", rubyScope: "all" }).ruby,
		"hide",
	);
	assert.equal(normalizeBookUi({ ruby: "on-demand" }).ruby, "on-demand");
});
test("automatic ruby strips safe okurigana and rejects kana-only or unavailable readings", () => {
	assert.deepEqual(rubyLabel("食べる", "タベル"), {
		surface: "食",
		reading: "た",
	});
	assert.deepEqual(rubyLabel("今日", "キョウ"), {
		surface: "今日",
		reading: "きょう",
	});
	assert.deepEqual(rubyLabel("行った", "イッタ"), {
		surface: "行",
		reading: "い",
	});
	assert.equal(rubyLabel("かな", "カナ"), null);
	assert.equal(rubyLabel("漢字", "*"), null);
});
