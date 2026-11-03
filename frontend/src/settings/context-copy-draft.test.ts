import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFields, parseCopyFields } from "./context-copy-draft.ts";

const preferences = {
	before_sentences: 3,
	after_sentences: 0,
	before_characters: 200,
	after_characters: 200,
	include_source: true,
};
const budgetFields = [
	"before_sentences",
	"after_sentences",
	"before_characters",
	"after_characters",
] as const;

test("copy fields convert saved budgets to raw inputs without response metadata", () => {
	const saved = { ...preferences, revision: 4 };
	const fields = copyFields(saved);
	assert.deepEqual(fields, {
		before_sentences: "3",
		after_sentences: "0",
		before_characters: "200",
		after_characters: "200",
		include_source: true,
	});
	assert.deepEqual(parseCopyFields(fields), preferences);
});

test("copy budget parsing rejects incomplete, non-integer and out-of-range inputs without changing them", () => {
	for (const field of budgetFields) {
		for (const value of [
			"",
			" ",
			"-1",
			"+1",
			"0.1",
			"1e2",
			"100001",
			"NaN",
			"Infinity",
			" 3",
			"3 ",
			"１２",
		]) {
			const fields = { ...copyFields(preferences), [field]: value };
			const before = { ...fields };
			assert.equal(
				parseCopyFields(fields),
				null,
				`${field}=${JSON.stringify(value)}`,
			);
			assert.deepEqual(fields, before);
		}
	}
});

test("copy budget parsing accepts zero, limits and leading zeros while retaining raw strings", () => {
	for (const field of budgetFields) {
		for (const value of ["0", "1", "100000", "003", "000"]) {
			const fields = {
				...copyFields(preferences),
				[field]: value,
				include_source: false,
			};
			const before = { ...fields };
			assert.deepEqual(parseCopyFields(fields), {
				...preferences,
				[field]: Number(value),
				include_source: false,
			});
			assert.deepEqual(fields, before);
		}
	}
});
