import assert from "node:assert/strict";
import test from "node:test";
import type { Segment, SegmentFields } from "../content.ts";
import { changedSegmentFields, segmentEditFields } from "./edit.ts";

const initial: Segment = {
	id: "segment",
	source_id: "source",
	text: "原文。",
	translation: "译文",
	context_before: "前文。",
	context_after: "後文。",
	transcription: "げんぶん。",
	source_ref: "出处",
	note: "备注",
	revision: 7,
	text_sha256: "a".repeat(64),
	text_locked_at: null,
	created_at: "2026-10-23T00:00:00Z",
	updated_at: "2026-10-23T00:00:00Z",
	material_provenance: null,
};
const fields: SegmentFields = {
	text: initial.text,
	translation: initial.translation,
	context_before: initial.context_before,
	context_after: initial.context_after,
	transcription: initial.transcription,
	source_ref: initial.source_ref,
	note: initial.note,
};

test("an untouched or restored draft has no writes", () => {
	assert.deepEqual(changedSegmentFields(fields, initial), {});
	assert.deepEqual(
		changedSegmentFields(
			{ ...fields, translation: initial.translation },
			initial,
		),
		{},
	);
});

for (const [name] of segmentEditFields) {
	test(`only changed ${name} is sent, including clearing optional fields`, () => {
		const value = name === "text" ? "変更した原文。" : "";
		assert.deepEqual(
			changedSegmentFields({ ...fields, [name]: value }, initial),
			{ [name]: value },
		);
	});
}

test("confirming a later revision retains the original field comparison", () => {
	const draft = { ...fields, translation: "自己的译文" };
	const confirmed = { ...initial, revision: 9 };
	assert.deepEqual(changedSegmentFields(draft, confirmed), {
		translation: "自己的译文",
	});
	assert.deepEqual(draft, { ...fields, translation: "自己的译文" });
	assert.equal(initial.revision, 7);
});

test("fixed original text is excluded while supplementary fields remain editable", () => {
	assert.deepEqual(
		changedSegmentFields(
			{ ...fields, text: "不可修改", note: "" },
			{ ...initial, text_locked_at: initial.created_at },
		),
		{ note: "" },
	);
});
