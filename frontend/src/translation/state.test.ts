import assert from "node:assert/strict";
import test from "node:test";
import {
	TranslationSubmission,
	targetText,
	translationTargetKey,
	translationVersionShortcut,
} from "./state.ts";

const range = {
	resource_id: "r",
	spine_index: 0,
	start: 0,
	end: 1,
	exact: "猫",
	text_sha256: "hash",
	prefix: "",
	suffix: "",
};
const target = {
	contract_version: "1" as const,
	material_id: "m",
	version_id: "v",
	ranges: [
		{
			resource_id: "r",
			spine_index: 0,
			start: 0,
			end: 1,
			exact: "猫",
			text_sha256: "hash",
			prefix: "",
			suffix: "",
		},
	],
};
test("same text at different spine occurrence never reuses identity", () => {
	assert.notEqual(
		translationTargetKey(target),
		translationTargetKey({
			...target,
			ranges: [{ ...range, spine_index: 1 }],
		}),
	);
	assert.equal(
		translationTargetKey(target),
		translationTargetKey({
			...target,
			ranges: [{ ...range, prefix: "ignored" }],
		}),
	);
});
test("version shortcut returns to the exact newer result even when history pages change", () => {
	const results = [{ id: "new" }, { id: "previous" }, { id: "old" }];
	assert.deepEqual(translationVersionShortcut(results, "new", null), {
		id: "previous",
		label: "上一版",
	});
	assert.deepEqual(
		translationVersionShortcut([{ id: "old" }], "previous", "new"),
		{ id: "new", label: "返回新版" },
	);
	assert.deepEqual(translationVersionShortcut(results, "previous", null), {
		id: "old",
		label: "上一版",
	});
	assert.equal(translationVersionShortcut(results, "old", null), null);
	assert.equal(translationVersionShortcut(results, "unloaded", null), null);
	assert.equal(translationVersionShortcut([], undefined, null), null);
});
test("snapshot concatenates base text before NFC", () => {
	assert.equal(
		targetText({
			...target,
			ranges: [
				{ ...range, exact: "か" },
				{ ...range, exact: "\u3099" },
			],
		}),
		"が",
	);
});
test("uncertain submission keeps the original request and rejects changed draft", () => {
	const submission = new TranslationSubmission<{ id: string }>();
	const request = submission.prepare("a", () => ({ id: "first" }));
	assert.equal(
		submission.prepare("a", () => ({ id: "second" })),
		request,
	);
	assert.throws(() => submission.prepare("b", () => ({ id: "third" })));
	submission.clear();
	assert.equal(submission.prepare("b", () => ({ id: "third" })).id, "third");
});
