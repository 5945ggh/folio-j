import assert from "node:assert/strict";
import test from "node:test";
import type { DictionaryMatch } from "./dictionary-api.ts";
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
