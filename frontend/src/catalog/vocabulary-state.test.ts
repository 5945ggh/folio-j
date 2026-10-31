import assert from "node:assert/strict";
import test from "node:test";
import {
	readVocabularyState,
	updateVocabularyState,
} from "./vocabulary-state.ts";

test("vocabulary URL restores filtering, selection and both pages", () => {
	const state = readVocabularyState(
		"?q=たべ&pos=動詞&sort=frequency_asc&page=3&word=食べる&occurrencePage=2",
	);
	assert.deepEqual(
		readVocabularyState(updateVocabularyState(state, {})),
		state,
	);
});
test("changing filters resets both result pages and the selected word", () => {
	const state = readVocabularyState(
		"?q=たべ&pos=動詞&page=3&word=食べる&occurrencePage=2",
	);
	assert.deepEqual(
		readVocabularyState(updateVocabularyState(state, { pos: "名詞" })),
		{
			q: "たべ",
			pos: "名詞",
			sort: "frequency_desc",
			page: 1,
			word: "",
			occurrencePage: 1,
		},
	);
});
test("opening and closing a word preserves list position and search", () => {
	const state = readVocabularyState("?q=猫&page=2");
	const opened = readVocabularyState(
		updateVocabularyState(state, { word: "山猫" }),
	);
	assert.equal(opened.page, 2);
	assert.equal(opened.q, "猫");
	assert.deepEqual(
		readVocabularyState(updateVocabularyState(opened, { word: "" })),
		state,
	);
});
test("malformed page and sort parameters cannot produce unbounded offsets", () => {
	for (const value of [
		"-1",
		"0",
		"NaN",
		"1.5",
		"Infinity",
		"999999999999999999",
	]) {
		const state = readVocabularyState(
			`?page=${value}&occurrencePage=${value}&sort=unknown`,
		);
		assert.equal(state.page, 1);
		assert.equal(state.occurrencePage, 1);
		assert.equal(state.sort, "frequency_desc");
	}
});
