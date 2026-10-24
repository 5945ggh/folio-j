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
		start: 0,
	});
	assert.deepEqual(rubyLabel("今日", "キョウ"), {
		surface: "今日",
		reading: "きょう",
		start: 0,
	});
	assert.deepEqual(rubyLabel("行った", "イッタ"), {
		surface: "行",
		reading: "い",
		start: 0,
	});
	assert.equal(rubyLabel("かな", "カナ"), null);
	assert.equal(rubyLabel("漢字", "*"), null);
});

test("automatic ruby leaves matching leading and trailing kana outside the annotation", () => {
	for (const [surface, reading, base, label, start] of [
		["まな板", "マナイタ", "板", "いた", 2],
		["低い", "ヒクイ", "低", "ひく", 0],
		["ひと休み", "ヒトヤスミ", "休", "やす", 2],
		["お早う", "オハヨウ", "早", "はよ", 1],
		["くノ一", "クノイチ", "一", "いち", 2],
		["パー券", "パーケン", "券", "けん", 2],
		["が向く", "ガムク", "向", "む", 1],
		["お𠮷", "オヨシ", "𠮷", "よし", 1],
		["取り扱い", "トリアツカイ", "取り扱", "とりあつか", 0],
	] as const) {
		assert.deepEqual(
			rubyLabel(surface, reading),
			{ surface: base, reading: label, start },
			surface,
		);
	}
});

test("automatic ruby keeps unmatched kana and never trims away the whole reading", () => {
	for (const [surface, reading, kana] of [
		["まな板", "イタ", "いた"],
		["お茶", "オ", "お"],
		["お早う", "オウ", "おう"],
	] as const) {
		assert.deepEqual(rubyLabel(surface, reading), {
			surface,
			reading: kana,
			start: 0,
		});
	}
});
