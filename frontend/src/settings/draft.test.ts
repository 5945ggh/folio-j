import assert from "node:assert/strict";
import { test } from "node:test";
import {
	completeDraft,
	createDraft,
	draftDirty,
	editDraft,
	receiveDraft,
	resetDraft,
	shouldBlockSettingsNavigation,
} from "./draft.ts";

test("editing clears saved feedback and reset restores the saved snapshot", () => {
	let draft = completeDraft(
		createDraft({ name: "a" }),
		{ name: "a" },
		{ name: "a" },
	);
	assert.equal(draft.saved, true);
	draft = editDraft(draft, { name: "b" });
	assert.equal(draft.saved, false);
	assert.equal(draftDirty(draft), true);
	draft = resetDraft(draft);
	assert.deepEqual(draft.value, { name: "a" });
	assert.equal(draftDirty(draft), false);
});

test("a query refresh does not replace dirty input", () => {
	const draft = editDraft(createDraft({ name: "a" }), { name: "typing" });
	assert.deepEqual(receiveDraft(draft, { name: "remote" }).value, draft.value);
	assert.deepEqual(
		receiveDraft(draft, { name: "remote" }).baseline,
		draft.baseline,
	);
	assert.deepEqual(
		receiveDraft(createDraft({ name: "a" }), { name: "remote" }).value,
		{ name: "remote" },
	);
});

test("the previous query snapshot cannot reset a locally accepted save", () => {
	const old = { name: "old" };
	const saved = { name: "saved" };
	const draft = completeDraft(editDraft(createDraft(old), saved), saved, saved);
	const beforeQueryNotification = receiveDraft(draft, { ...old });
	assert.deepEqual(beforeQueryNotification.value, saved);
	assert.equal(beforeQueryNotification.saved, true);
	const afterQueryNotification = receiveDraft(beforeQueryNotification, {
		...saved,
	});
	assert.deepEqual(afterQueryNotification.value, saved);
	assert.equal(afterQueryNotification.saved, true);
});

test("discarding local edits adopts a newer snapshot observed while dirty", () => {
	const old = { name: "old" };
	const remote = { name: "remote" };
	const draft = receiveDraft(
		editDraft(createDraft(old), { name: "typing" }),
		remote,
	);
	const reset = resetDraft(draft);
	assert.deepEqual(reset.value, remote);
	assert.equal(draftDirty(reset), false);
	assert.deepEqual(receiveDraft(reset, { ...remote }).value, remote);
	assert.deepEqual(editDraft(draft, old).value, remote);
});

test("discarding edits after a save uses the accepted baseline before query notification", () => {
	const saved = { name: "saved" };
	const accepted = completeDraft(
		editDraft(createDraft({ name: "old" }), saved),
		saved,
		saved,
	);
	assert.deepEqual(
		resetDraft(editDraft(accepted, { name: "typing again" })).value,
		saved,
	);
});

test("save completion keeps edits made after the submitted snapshot", () => {
	const draft = editDraft(createDraft({ name: "a" }), { name: "newer" });
	const result = completeDraft(
		draft,
		{ name: "submitted" },
		{ name: "persisted" },
	);
	assert.deepEqual(result.value, { name: "newer" });
	assert.deepEqual(result.baseline, { name: "persisted" });
	assert.equal(result.saved, false);
	assert.equal(draftDirty(result), true);
});

test("saved response becomes the new baseline and failure leaves the draft unchanged", () => {
	const draft = editDraft(createDraft({ name: "a" }), { name: "b " });
	const result = completeDraft(draft, draft.value, { name: "b" });
	assert.deepEqual(result.value, { name: "b" });
	assert.equal(result.saved, true);
	assert.equal(draftDirty(result), false);
	// A failed save never applies completeDraft.
	assert.equal(draftDirty(draft), true);
});

test("navigation protects path, category, back/forward and pending saves", () => {
	const current = { pathname: "/settings", search: "", hash: "" };
	const dirty = [{ dirty: true, pending: false }];
	assert.equal(shouldBlockSettingsNavigation(current, current, dirty), false);
	for (const next of [
		{ ...current, pathname: "/materials" },
		{ ...current, search: "?section=learning" },
		{ ...current, search: "?section=history" },
	])
		assert.equal(shouldBlockSettingsNavigation(current, next, dirty), true);
	assert.equal(
		shouldBlockSettingsNavigation(
			current,
			{ ...current, pathname: "/sources" },
			[{ dirty: false, pending: true }],
		),
		true,
	);
	assert.equal(
		shouldBlockSettingsNavigation(
			current,
			{ ...current, pathname: "/sources" },
			[{ dirty: false, pending: false }],
		),
		false,
	);
});
