import assert from "node:assert/strict";
import test from "node:test";
import type {
	DictionaryMatch,
	DictionarySourceAnalysis,
} from "./dictionary-api.ts";
import { dictionaryPages } from "./dictionary-pages.ts";

test("pages preserve ranked entries and distinguish equal spellings at different positions", () => {
	const match = (id: string, start: number): DictionaryMatch => ({
		id,
		dictionary_id: "one",
		start,
		end: start + 2,
		surface: "人人",
		term: "人人",
		reading: "",
		definitions: [],
	});
	const pages = dictionaryPages([
		match("first", 1),
		match("second", 0),
		match("third", 1),
	]);
	assert.deepEqual(
		pages.map((p) => [p.start, p.end, p.entries.map((e) => e.id)]),
		[
			[1, 3, ["first", "third"]],
			[0, 2, ["second"]],
		],
	);
});

test("a longer source analysis cannot displace or add pages to dictionary matches", () => {
	const source = (start: number): DictionarySourceAnalysis => ({
		start,
		end: start + 1,
		surface: "人",
		reading: "ヒト",
		components: [],
		inflection: [],
	});
	const match: DictionaryMatch = {
		id: "one",
		dictionary_id: "one",
		start: 3,
		end: 4,
		term: "人",
		surface: "人",
		reading: "じん",
		definitions: [],
	};
	const first = source(0);
	const second = source(3);
	const longer = { ...first, end: 4, surface: "人人人人" };
	assert.deepEqual(dictionaryPages([match], [longer, first, second]), [
		{ start: 3, end: 4, surface: "人", entries: [match], analysis: second },
	]);
	assert.deepEqual(
		dictionaryPages([], [first, second]).map((page) => page.analysis),
		[first, second],
	);
	assert.deepEqual(dictionaryPages([], []), []);
});
