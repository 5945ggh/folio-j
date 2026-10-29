import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextCopySettings } from "./context-copy-api.ts";
import {
	completeCopyDraft,
	conflictCopyDraft,
	copyDraftDirty,
	copyDraftRequest,
	copyFields,
	createCopyDraft,
	editCopyDraft,
	parseCopyFields,
	receiveCopySettings,
	reloadCopyDraft,
} from "./context-copy-draft.ts";

const defaults: ContextCopySettings = {
	before_sentences: 3,
	after_sentences: 0,
	before_characters: 200,
	after_characters: 200,
	include_source: true,
	revision: 0,
};

test("numeric copy drafts preserve raw edits and reject invalid values without substituting defaults", () => {
	const initial = createCopyDraft(defaults);
	for (const field of [
		"before_sentences",
		"after_sentences",
		"before_characters",
		"after_characters",
	] as const) {
		for (const value of ["", "-1", "0.1", "100001", "1e2", "NaN", " "]) {
			const draft = editCopyDraft(initial, {
				...initial.fields,
				[field]: value,
			});
			assert.equal(draft.fields[field], value);
			assert.equal(copyDraftRequest(draft), null);
			assert.equal(parseCopyFields(draft.fields), null);
		}
		for (const value of ["0", "1", "100000", "003"]) {
			const draft = editCopyDraft(initial, {
				...initial.fields,
				[field]: value,
			});
			assert.equal(copyDraftRequest(draft)?.[field], Number(value));
		}
	}
	assert.equal(copyDraftDirty(initial), false);
	const { revision, ...preferences } = defaults;
	assert.deepEqual(copyDraftRequest(initial), {
		...preferences,
		expected_revision: revision,
	});
});

test("a conflict preserves every input and requires explicit rereading before another write", () => {
	const initial = createCopyDraft(defaults);
	const fields = {
		...initial.fields,
		before_sentences: "007",
		include_source: false,
	};
	const conflicted = conflictCopyDraft(editCopyDraft(initial, fields));
	assert.deepEqual(conflicted.fields, fields);
	assert.equal(copyDraftRequest(conflicted), null);
	const latest = { ...defaults, after_sentences: 8, revision: 3 };
	const observed = receiveCopySettings(conflicted, latest);
	assert.deepEqual(observed.fields, fields);
	assert.equal(copyDraftRequest(observed), null);
	const rebased = reloadCopyDraft(observed, latest, true);
	assert.deepEqual(rebased.fields, fields);
	assert.deepEqual(copyDraftRequest(rebased), {
		before_sentences: 7,
		after_sentences: 0,
		before_characters: 200,
		after_characters: 200,
		include_source: false,
		expected_revision: 3,
	});
	assert.equal(copyDraftDirty(rebased), true);
	const discarded = reloadCopyDraft(observed, latest, false);
	assert.deepEqual(discarded.fields, copyFields(latest));
	assert.equal(copyDraftDirty(discarded), false);
});

test("a refreshed server revision keeps unsaved edits and cannot silently change the write revision", () => {
	const initial = createCopyDraft(defaults);
	const edited = editCopyDraft(initial, {
		...initial.fields,
		before_sentences: "9",
	});
	const latest = { ...defaults, before_sentences: 4, revision: 2 };
	const updated = receiveCopySettings(edited, latest);
	assert.equal(updated.baseline.revision, 0);
	assert.equal(updated.latest.revision, 2);
	assert.equal(updated.fields.before_sentences, "9");
	assert.equal(copyDraftRequest(updated), null);
	assert.equal(receiveCopySettings(updated, defaults), updated);
	assert.deepEqual(
		receiveCopySettings(initial, latest),
		createCopyDraft(latest),
	);
	assert.equal(reloadCopyDraft(updated, defaults, true).baseline.revision, 2);
});

test("save completion accepts its response and preserves a submitted draft superseded by a newer revision", () => {
	const initial = createCopyDraft(defaults);
	const draft = editCopyDraft(initial, {
		...initial.fields,
		after_sentences: "2",
	});
	const saved = { ...defaults, after_sentences: 2, revision: 1 };
	assert.deepEqual(
		completeCopyDraft(draft, saved, saved),
		createCopyDraft(saved),
	);
	const latest = { ...defaults, before_sentences: 8, revision: 2 };
	const superseded = completeCopyDraft(draft, saved, latest);
	assert.deepEqual(superseded.fields, draft.fields);
	assert.equal(superseded.latest.revision, 2);
	assert.equal(superseded.conflict, true);
	assert.equal(copyDraftRequest(superseded), null);
});
