import assert from "node:assert/strict";
import test from "node:test";
import {
	createTranslationSession,
	notifyTranslationSession,
	TranslationSubmission,
	targetText,
	translationTargetKey,
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

test("target sessions keep frozen requests and notify remounted observers independently", () => {
	const first = createTranslationSession();
	const second = createTranslationSession();
	const body = first.request.prepare("draft", () => ({
		request_id: "original",
		source_id: "source",
		text: "猫",
		material_provenance: target,
		context_before: "前文",
		context_after: "",
	}));
	first.pending = true;
	const sessions = new Map([[translationTargetKey(target), first]]);
	assert.equal(sessions.get(translationTargetKey(target)), first);
	assert.equal(first.request.current, body);
	assert.equal(second.request.current, undefined);
	let notifications = 0;
	const observer = () => {
		notifications++;
	};
	first.listeners.add(observer);
	first.pending = false;
	first.uncertain = true;
	notifyTranslationSession(first);
	assert.equal(notifications, 1);
	assert.equal(first.version, 1);
	assert.equal(second.version, 0);
	assert.equal(first.request.current?.request_id, "original");
	first.listeners.delete(observer);
	first.request.clear();
	assert.equal(first.request.current, undefined);
});
