import assert from "node:assert/strict";
import test from "node:test";
import {
	type AnalysisDraft,
	type AnalysisEditorBase,
	AnalysisWriteError,
	analysisDraftChanged,
	analysisFailure,
	analysisWriteError,
	prepareAnalysisRequest,
	requestAfterFailure,
	savedAnalysisLocation,
	sourceChanged,
	sourceError,
	titleError,
} from "./editor.ts";

const base: AnalysisEditorBase = {
	segment: {
		id: "segment",
		source_id: "source",
		text_sha256: "original-hash",
		text_locked_at: null,
	},
};
const draft: AnalysisDraft = {
	sourceMd: "## は\u3099な\n説明\n",
	title: " 外部講解 ",
};
const editing: AnalysisEditorBase = {
	...base,
	analysis: {
		id: "analysis",
		segment_id: "segment",
		revision_id: "base-revision",
		current_revision_id: "base-revision",
		source_md: "ばな",
	},
};

test("manual requests capture original text and exact revision, while retry freezes every submitted field", () => {
	let identifiers = 0;
	const createId = () => `request-${++identifiers}`;
	const request = prepareAnalysisRequest(null, base, draft, createId);
	assert.equal(request.kind, "create");
	assert.deepEqual(request.body, {
		request_id: "request-1",
		expected_text_sha256: "original-hash",
		source_md: "## ばな\n説明\n",
		origin: "manual",
		title: "外部講解",
	});
	assert.equal(Object.isFrozen(request), true);
	assert.equal(Object.isFrozen(request.body), true);
	const retained = requestAfterFailure(request, new TypeError("lost response"));
	assert.equal(retained, request);
	assert.equal(
		prepareAnalysisRequest(
			retained,
			{ ...base, segment: { ...base.segment, text_sha256: "new-hash" } },
			{ ...draft, sourceMd: "新草稿", title: "新标题" },
			createId,
		),
		request,
	);
	assert.equal(identifiers, 1);
	const rejected = requestAfterFailure(request, analysisWriteError({}, 422));
	assert.equal(rejected, null);
	const corrected = prepareAnalysisRequest(
		rejected,
		base,
		{ ...draft, sourceMd: "修正后的正文" },
		createId,
	);
	assert.equal(corrected.body.request_id, "request-2");
	const replace = prepareAnalysisRequest(
		null,
		editing,
		{ ...draft, sourceMd: "新正文" },
		createId,
	);
	assert.equal(replace.kind, "revision");
	assert.deepEqual(replace.body, {
		request_id: "request-3",
		expected_text_sha256: "original-hash",
		source_md: "新正文",
		base_revision_id: "base-revision",
	});
});

test("no-op compares NFC without dropping Markdown whitespace; limits count Unicode codepoints", () => {
	assert.equal(sourceChanged(editing, "は\u3099な"), false);
	assert.equal(
		analysisDraftChanged(editing, { ...draft, sourceMd: "は\u3099な" }),
		false,
	);
	let minted = false;
	assert.throws(
		() =>
			prepareAnalysisRequest(
				null,
				editing,
				{ ...draft, sourceMd: "は\u3099な" },
				() => {
					minted = true;
					return "unused";
				},
			),
		/变化/,
	);
	assert.equal(minted, false);
	assert.equal(sourceChanged(editing, "ばな\n"), true);
	assert.equal(sourceError(" \n\t"), "讲解正文不能为空白。");
	assert.equal(sourceError("𠮷".repeat(500_000)), null);
	assert.ok(sourceError("𠮷".repeat(500_001)));
	assert.equal(titleError("𠮷".repeat(200)), null);
	assert.ok(titleError("𠮷".repeat(201)));
	const currentAnalysis = editing.analysis;
	assert.ok(currentAnalysis);
	assert.throws(
		() =>
			prepareAnalysisRequest(
				null,
				{
					...editing,
					analysis: { ...currentAnalysis, current_revision_id: "newer" },
				},
				{ ...draft, sourceMd: "新正文" },
				() => "unused",
			),
		/历史版本/,
	);
});

test("only definite rejection releases a request; timeouts, 5xx, malformed success and network errors require verification", () => {
	const request = prepareAnalysisRequest(null, base, draft, () => "request");
	for (const failure of [
		new Error("network"),
		new DOMException("Timeout", "TimeoutError"),
		analysisWriteError({}, 408),
		analysisWriteError({}, 500),
		analysisWriteError({}, 503),
		analysisWriteError({}, 200),
	]) {
		assert.equal(analysisFailure(failure), "uncertain");
		assert.equal(requestAfterFailure(request, failure), request);
	}
	for (const code of [
		"stale_text",
		"stale_revision",
		"idempotency_conflict",
		"not_found",
		"no_changes",
	] as const) {
		const failure = new AnalysisWriteError(
			"拒绝",
			code === "no_changes" ? 422 : code === "not_found" ? 404 : 409,
			code,
		);
		assert.equal(analysisFailure(failure), code);
		assert.equal(requestAfterFailure(request, failure), null);
	}
	const validation = analysisWriteError(
		{
			detail: [
				{ loc: ["body", "source_md"], msg: "invalid", input: "must not echo" },
			],
		},
		422,
	);
	assert.equal(analysisFailure(validation), "rejected");
	assert.doesNotMatch(validation.message, /must not echo|\[object/);
	assert.equal(analysisFailure(analysisWriteError({}, 429)), "rejected");
});

test("replayed success opens its original saved revision rather than a later current revision", () => {
	assert.deepEqual(
		savedAnalysisLocation({
			id: "analysis",
			revision_id: "original-save",
			current_revision_id: "newer-save",
		}),
		{ analysisId: "analysis", revisionId: "original-save" },
	);
});
