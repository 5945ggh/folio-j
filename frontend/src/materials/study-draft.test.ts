import assert from "node:assert/strict";
import test from "node:test";
import type { MaterialProvenance } from "./study-api";
import {
	applyContextFill,
	applyStudyTranslation,
	beginContextFill,
	contextInputError,
	createContextDraft,
	detachStudyTranslation,
	editContext,
	editStudyTranslation,
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

test("clearing both sides protects empty context from a delayed fill and saves only the target", () => {
	let draft = applyContextFill(
		beginContextFill(createContextDraft("target")),
		"target",
		1,
		fill,
	);
	draft = beginContextFill(draft);
	draft = editContext(draft, "before", "");
	draft = editContext(draft, "after", "");
	const cleared = structuredClone(draft);
	draft = applyContextFill(draft, "target", 2, fill);
	assert.deepEqual(draft, cleared);
	assert.equal(draft.before.edited, true);
	assert.equal(draft.after.edited, true);
	assert.equal(draft.before.automatic, false);
	assert.equal(draft.after.automatic, false);
	const request = prepareStudyRequest(null, reference, draft, () => "cleared");
	assert.equal(request.context_before, "");
	assert.equal(request.context_after, "");
	assert.deepEqual(request.material_provenance, reference);
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

test("译文只预填一次，迟到结果不覆盖修改、清空或另一目标", () => {
	const initial = createContextDraft("target");
	const result = { id: "translation-a", translation: "译文" };
	assert.equal(applyStudyTranslation(initial, "other", result), initial);
	const filled = applyStudyTranslation(initial, "target", result);
	assert.equal(filled.translation.value, "译文");
	assert.equal(
		applyStudyTranslation(filled, "target", {
			id: "translation-b",
			translation: "新译文",
		}),
		filled,
	);
	for (const value of ["手动译文", ""]) {
		const edited = editStudyTranslation(initial, value);
		assert.equal(applyStudyTranslation(edited, "target", result), edited);
		assert.equal(edited.translation.value, value);
	}
});

test("提交冻结实际译文及关联结果，核实时不改选区或采用其他结果", () => {
	let draft = applyStudyTranslation(createContextDraft("target"), "target", {
		id: "translation-a",
		translation: "カ\u3099",
	});
	const request = prepareStudyRequest(
		null,
		reference,
		draft,
		() => "translation-save",
	);
	assert.equal(request.translation, "ガ");
	assert.equal(request.translation_result_id, "translation-a");
	assert.deepEqual(request.material_provenance, reference);
	draft = editStudyTranslation(draft, "");
	assert.equal(
		prepareStudyRequest(request, reference, draft, () => "retry"),
		request,
	);
	assert.equal(
		prepareStudyRequest(null, reference, draft, () => "clear").translation,
		"",
	);
	assert.equal(
		contextInputError(editStudyTranslation(draft, "😀".repeat(100_001))),
		"译文和前后文各不能超过 100,000 个字符。",
	);
});

test("解除失效译文关联保留全部草稿文字并阻止迟到预填", () => {
	let draft = applyStudyTranslation(createContextDraft("target"), "target", {
		id: "removed",
		translation: "原译文",
	});
	draft = editContext(draft, "before", "手动前文");
	for (const text of ["原译文", "我的改写", ""]) {
		const changed =
			text === "原译文" ? draft : editStudyTranslation(draft, text);
		assert.equal(detachStudyTranslation(changed, "other", null), changed);
		const detached = detachStudyTranslation(changed, "removed", null);
		assert.equal(detached.translation.value, text);
		assert.equal(detached.translation.resultId, null);
		assert.equal(detached.translation.edited, true);
		assert.equal(detached.before, changed.before);
		assert.equal(detached.after, changed.after);
		assert.equal(
			applyStudyTranslation(detached, "target", {
				id: "late",
				translation: "迟到译文",
			}),
			detached,
		);
		const request = prepareStudyRequest(
			null,
			reference,
			detached,
			() => "independent",
		);
		assert.equal(request.translation, text);
		assert.equal(request.translation_result_id, undefined);
		assert.equal(request.context_before, "手动前文");
	}
});

test("提交中及结果不确定时解除关联不能改写冻结请求，明确失败后可独立保存", () => {
	const draft = applyStudyTranslation(createContextDraft("target"), "target", {
		id: "removed",
		translation: "保留译文",
	});
	const request = prepareStudyRequest(null, reference, draft, () => "original");
	assert.equal(detachStudyTranslation(draft, "removed", null, true), draft);
	assert.equal(detachStudyTranslation(draft, "removed", request), draft);
	assert.equal(
		prepareStudyRequest(request, reference, draft, () => "wrong"),
		request,
	);
	assert.equal(request.translation_result_id, "removed");
	assert.equal(request.request_id, "original");
	const detached = detachStudyTranslation(draft, "removed", null);
	// Even an already changed local draft cannot mutate the exact request used for verification.
	assert.equal(
		prepareStudyRequest(request, reference, detached, () => "wrong"),
		request,
	);
	const fresh = prepareStudyRequest(
		null,
		reference,
		detached,
		() => "after-definite-failure",
	);
	assert.equal(fresh.translation, "保留译文");
	assert.equal(fresh.translation_result_id, undefined);
	assert.equal(fresh.request_id, "after-definite-failure");
});
