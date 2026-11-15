import assert from "node:assert/strict";
import test from "node:test";
import { dictionaryReading } from "./dictionary-reading.ts";

test("假名转写保留原表层的拗音、促音、长音和拨音", () => {
	const examples = [
		["キョウ", "きょう", "kyou"],
		["ｶﾞｯｺｳ", "がっこう", "gakkou"],
		["マッチ", "まっち", "matchi"],
		["シンヨウ", "しんよう", "shin'you"],
		["スーパー", "すーぱー", "sūpā"],
		["シャンプー", "しゃんぷー", "shanpū"],
		["ヴァイオリン", "ゔぁいおりん", "vaiorin"],
	];
	for (const [input = "", kana, romaji] of examples)
		assert.deepEqual(dictionaryReading(input), { kana, romaji });
});

test("缺失或混有汉字和拉丁字母的读音不转写，孤立促音只显示假名", () => {
	for (const reading of ["", "未知", "お茶", "AIエーアイ"])
		assert.equal(dictionaryReading(reading), null);
	assert.deepEqual(dictionaryReading("アッ"), { kana: "あっ", romaji: "" });
});
