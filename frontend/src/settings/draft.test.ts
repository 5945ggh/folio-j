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

test("a refresh cannot replace a queued return to the baseline while saving", () => {
	const original = { name: "a" };
	const firstSave = { name: "b" };
	let draft = editDraft(createDraft(original), firstSave);
	draft = editDraft(draft, original, true);
	assert.equal(draftDirty(draft), false);
	draft = receiveDraft(draft, firstSave, true);
	assert.deepEqual(draft.value, original);
	assert.deepEqual(draft.baseline, firstSave);
	assert.deepEqual(draft.source, firstSave);
	draft = completeDraft(draft, firstSave, firstSave);
	assert.deepEqual(draft.value, original);
	assert.equal(draftDirty(draft), true);
	draft = completeDraft(draft, original, original);
	draft = receiveDraft(draft, { ...firstSave }, true);
	assert.deepEqual(draft.value, original);
	assert.equal(draft.saved, true);
	draft = receiveDraft(draft, { ...original });
	assert.deepEqual(draft.value, original);
	assert.deepEqual(draft.source, original);
	assert.equal(draftDirty(draft), false);
	assert.equal(draft.saved, true);
});

test("an explicit return to the baseline is preserved after a remote refresh", () => {
	const original = { name: "a" };
	const remote = { name: "b" };
	const refreshed = receiveDraft(
		editDraft(createDraft(original), { name: "typing" }),
		remote,
	);
	assert.deepEqual(editDraft(refreshed, original).value, remote);
	const selected = editDraft(refreshed, original, true);
	assert.deepEqual(selected.value, original);
	assert.deepEqual(selected.baseline, remote);
	assert.equal(draftDirty(selected), true);
	assert.deepEqual(receiveDraft(selected, remote, true).value, original);
});

test("a failed save retains preserved input as dirty against the observed server snapshot", () => {
	const original = { name: "a" };
	const remote = { name: "b" };
	const held = receiveDraft(createDraft(original), remote, true);
	assert.deepEqual(held.value, original);
	assert.deepEqual(held.baseline, remote);
	assert.equal(draftDirty(held), true);
	const failed = receiveDraft(held, remote);
	assert.deepEqual(failed.value, original);
	assert.equal(draftDirty(failed), true);
	assert.deepEqual(resetDraft(failed).value, remote);
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
		{ ...current, search: "?section=providers" },
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

test("service panel drafts and pending saves protect return to default models", () => {
	const services = {
		pathname: "/settings",
		search: "?section=providers",
		hash: "",
	};
	const defaults = { ...services, search: "" };
	for (const state of [
		{ dirty: true, pending: false },
		{ dirty: false, pending: true },
	]) {
		assert.equal(
			shouldBlockSettingsNavigation(services, defaults, [state]),
			true,
		);
		assert.equal(
			shouldBlockSettingsNavigation(services, services, [state]),
			false,
		);
	}
	assert.equal(
		shouldBlockSettingsNavigation(services, defaults, [
			{ dirty: false, pending: false },
		]),
		false,
	);
});
