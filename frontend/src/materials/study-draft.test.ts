import assert from "node:assert/strict";
import test from "node:test";
import type { MaterialProvenance } from "./study-api";
import {
	applyContextFill,
	beginContextFill,
	contextInputError,
	createContextDraft,
	editContext,
	prepareStudyRequest,
	uncertainStudyFailure,
} from "./study-draft.ts";

const fill = {
	before: "前。",
	after: "後。",
	beforeTruncated: true,
	afterTruncated: false,
};
const reference: MaterialProvenance = {
	contract_version: "1",
	material_id: "m",
	version_id: "v",
	ranges: [
		{
			resource_id: "r",
			spine_index: 2,
			start: 1,
			end: 2,
			exact: "学",
			text_sha256: "a".repeat(64),
			prefix: "",
			suffix: "",
		},
	],
};

test("late initial fill protects independently edited and explicitly cleared fields", () => {
	let draft = beginContextFill(createContextDraft("first"));
	draft = editContext(draft, "before", "");
	draft = applyContextFill(draft, "first", 1, fill);
	assert.equal(draft.before.value, "");
	assert.equal(draft.before.edited, true);
	assert.equal(draft.after.value, "後。");
	assert.equal(draft.after.automatic, true);
	draft = editContext(draft, "after", "手動");
	draft = applyContextFill(draft, "first", 1, fill);
	assert.equal(draft.after.value, "手動");
	assert.equal(draft.after.automatic, false);
});

test("target replacement and later attempts invalidate earlier fills, explicit replacement uses current proposal", () => {
	let draft = beginContextFill(createContextDraft("second"));
	assert.equal(applyContextFill(draft, "first", 1, fill), draft);
	draft = beginContextFill(editContext(draft, "before", "保留"));
	assert.equal(applyContextFill(draft, "second", 1, fill, true), draft);
	assert.equal(draft.before.value, "保留");
	draft = applyContextFill(draft, "second", 2, fill, true);
	assert.equal(draft.before.value, "前。");
	assert.equal(draft.before.truncated, true);
});

test("submission freezes context and reference; uncertain retry retains the entire original request", () => {
	let draft = editContext(createContextDraft("target"), "before", "カ\u3099");
	const mutableReference = structuredClone(reference);
	const request = prepareStudyRequest(
		null,
		mutableReference,
		draft,
		() => "one",
	);
	assert.equal(request.context_before, "ガ");
	assert.equal(request.text, undefined);
	const originalRange = mutableReference.ranges[0];
	assert.ok(originalRange);
	originalRange.exact = "別";
	assert.equal(request.material_provenance?.ranges[0]?.exact, "学");
	draft = editContext(draft, "before", "変更");
	assert.equal(
		prepareStudyRequest(request, reference, draft, () => "two"),
		request,
	);
	assert.ok(Object.isFrozen(request));
	assert.ok(Object.isFrozen(request.material_provenance?.ranges[0]));
	assert.equal(uncertainStudyFailure(new TypeError("connection lost")), true);
	assert.equal(uncertainStudyFailure({ status: 503 }), true);
	for (const status of [404, 409, 422])
		assert.equal(uncertainStudyFailure({ status }), false);
});

test("manual context is not cut to automatic budget and its input limit counts NFC codepoints", () => {
	let draft = editContext(
		createContextDraft("target"),
		"after",
		"😀".repeat(100_000),
	);
	assert.equal(contextInputError(draft), null);
	assert.equal(
		Array.from(
			prepareStudyRequest(null, reference, draft, () => "id").context_after,
		).length,
		100_000,
	);
	draft = editContext(draft, "after", "😀".repeat(100_001));
	assert.match(contextInputError(draft) ?? "", /100,000/);
	assert.throws(() => prepareStudyRequest(null, reference, draft, () => "id"));
});
