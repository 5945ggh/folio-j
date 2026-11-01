import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextCopySettings } from "../settings/context-copy-api.ts";
import { copyFields } from "../settings/context-copy-draft.ts";
import {
	createReaderCopyEditor,
	readerCopyEditorStatus,
} from "./reader-copy-editor.ts";

const defaults: ContextCopySettings = {
	before_sentences: 3,
	after_sentences: 0,
	before_characters: 200,
	after_characters: 200,
	include_source: true,
	revision: 0,
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((accept, decline) => {
		resolve = accept;
		reject = decline;
	});
	return { promise, resolve, reject };
}

function setup(
	overrides: Partial<Parameters<typeof createReaderCopyEditor>[0]> = {},
) {
	const editor = createReaderCopyEditor(
		{
			save: async (request) => ({
				before_sentences: request.before_sentences,
				after_sentences: request.after_sentences,
				before_characters: request.before_characters,
				after_characters: request.after_characters,
				include_source: request.include_source,
				revision: request.expected_revision + 1,
			}),
			commit: async (saved) => saved,
			reload: async () => defaults,
			...overrides,
		},
		defaults,
	);
	editor.setActive(true);
	const status = () => readerCopyEditorStatus(editor.getSnapshot());
	return { editor, status };
}

test("closing consumers leaves raw copy drafts intact and discard uses the latest known server settings", () => {
	const { editor, status } = setup();
	let updates = 0;
	const unsubscribe = editor.subscribe(() => updates++);
	editor.change({ ...copyFields(defaults), before_sentences: "" });
	unsubscribe();
	editor.receive({ ...defaults, before_sentences: 7, revision: 2 });
	assert.equal(status().fields?.before_sentences, "");
	assert.equal(status().dirty, true);
	assert.equal(status().valid, false);
	assert.equal(status().needsReload, true);
	assert.equal(updates, 1);
	editor.discard();
	assert.equal(status().fields?.before_sentences, "7");
	assert.equal(status().dirty, false);
	assert.equal(status().needsReload, false);
});

test("save freezes one request and all callers await the same promise through cache commit", async () => {
	const response = deferred<ContextCopySettings>();
	const commit = deferred<ContextCopySettings>();
	const requests: unknown[] = [];
	const { editor, status } = setup({
		save: (request) => {
			requests.push(request);
			return response.promise;
		},
		commit: () => commit.promise,
	});
	const fields = { ...copyFields(defaults), before_sentences: "007" };
	editor.change(fields);
	const first = editor.save();
	const second = editor.save();
	assert.equal(first, second);
	assert.equal(status().pending, true);
	fields.before_sentences = "99";
	editor.change({ ...fields, before_sentences: "8" });
	editor.resetDefaults();
	editor.discard();
	assert.equal(await editor.reload(false), false);
	await Promise.resolve();
	assert.equal(requests.length, 1);
	const { revision, ...preferences } = defaults;
	assert.deepEqual(requests[0], {
		...preferences,
		before_sentences: 7,
		expected_revision: revision,
	});
	assert.equal(status().fields?.before_sentences, "007");
	const saved = { ...defaults, before_sentences: 7, revision: 1 };
	response.resolve(saved);
	await Promise.resolve();
	assert.equal(status().pending, true);
	commit.resolve(saved);
	assert.equal(await first, true);
	assert.equal(status().pending, false);
	assert.equal(status().dirty, false);
	assert.equal(status().fields?.before_sentences, "7");
});

test("failed saves retain inputs, unlock the editor, and allow an explicit retry", async () => {
	let calls = 0;
	const { editor, status } = setup({
		save: async () => {
			calls++;
			if (calls === 1) throw new Error("offline");
			return { ...defaults, after_sentences: 2, revision: 1 };
		},
	});
	editor.change({ ...copyFields(defaults), after_sentences: "2" });
	assert.equal(await editor.save(), false);
	assert.equal(status().fields?.after_sentences, "2");
	assert.equal(status().noticeError, true);
	assert.equal(status().pending, false);
	assert.equal(await editor.save(), true);
	assert.equal(calls, 2);
	assert.equal(status().noticeError, false);
});

test("conflicts require an explicit rebase and a failed reload never substitutes defaults", async () => {
	let reloadFails = true;
	const latest = { ...defaults, before_sentences: 8, revision: 4 };
	const { editor, status } = setup({
		save: async () => {
			throw { status: 409 };
		},
		reload: async () => {
			if (reloadFails) throw new Error("offline");
			return latest;
		},
	});
	editor.change({ ...copyFields(defaults), after_sentences: "9" });
	assert.equal(await editor.save(), false);
	assert.equal(status().needsReload, true);
	assert.equal(await editor.save(), false);
	assert.equal(await editor.reload(false), false);
	assert.equal(status().fields?.after_sentences, "9");
	assert.equal(status().needsReload, true);
	reloadFails = false;
	assert.equal(await editor.reload(true), true);
	assert.equal(status().needsReload, false);
	assert.equal(status().fields?.after_sentences, "9");
	assert.equal(editor.getSnapshot().draft?.baseline.revision, 4);
	editor.discard();
	assert.deepEqual(status().fields, copyFields(latest));
});

test("a superseding server revision prevents save success from erasing the submitted draft", async () => {
	const response = deferred<ContextCopySettings>();
	const { editor, status } = setup({ save: () => response.promise });
	editor.change({ ...copyFields(defaults), after_sentences: "2" });
	const saved = editor.save();
	editor.receive({ ...defaults, before_sentences: 8, revision: 2 });
	response.resolve({ ...defaults, after_sentences: 2, revision: 1 });
	assert.equal(await saved, false);
	assert.equal(status().fields?.after_sentences, "2");
	assert.equal(status().needsReload, true);
	assert.equal(status().dirty, true);
});

test("pausing and resuming never revives an old asynchronous error or interrupts cache publication", async () => {
	const response = deferred<ContextCopySettings>();
	let committed = false;
	const { editor, status } = setup({
		save: () => response.promise,
		commit: async (saved) => {
			committed = true;
			return saved;
		},
	});
	editor.change({ ...copyFields(defaults), after_sentences: "4" });
	const save = editor.save();
	editor.setActive(false);
	editor.setActive(true);
	response.reject(new Error("late failure"));
	assert.equal(await save, false);
	assert.equal(status().notice, "");
	assert.equal(status().dirty, true);
	assert.equal(status().pending, false);
	assert.equal(committed, false);

	const successful = setup({
		commit: async (saved) => {
			committed = true;
			return saved;
		},
	});
	successful.editor.change({ ...copyFields(defaults), after_sentences: "4" });
	const pending = successful.editor.save();
	successful.editor.setActive(false);
	assert.equal(await pending, true);
	assert.equal(committed, true);
	assert.equal(successful.status().notice, "");
});

test("restore defaults edits only the draft and invalid input never calls persistence", async () => {
	let calls = 0;
	const { editor, status } = setup({
		save: async () => {
			calls++;
			return defaults;
		},
	});
	const latest = { ...defaults, before_sentences: 12, revision: 3 };
	editor.receive(latest);
	editor.resetDefaults();
	assert.equal(status().dirty, true);
	assert.deepEqual(status().fields, {
		before_sentences: "2",
		after_sentences: "2",
		before_characters: "100",
		after_characters: "100",
		include_source: true,
	});
	assert.equal(editor.getSnapshot().draft?.latest, latest);
	editor.change({ ...copyFields(defaults), before_sentences: "" });
	assert.equal(await editor.save(), false);
	assert.equal(calls, 0);
});

test("a pending reload cannot be replaced by save or a second reload with different discard intent", async () => {
	const response = deferred<ContextCopySettings>();
	const { editor, status } = setup({ reload: () => response.promise });
	editor.change({ ...copyFields(defaults), after_sentences: "5" });
	const reload = editor.reload(true);
	assert.equal(editor.reload(false), reload);
	assert.equal(await editor.save(), false);
	assert.equal(status().pending, true);
	assert.equal(status().saving, false);
	response.resolve({ ...defaults, revision: 2 });
	assert.equal(await reload, true);
	assert.equal(status().fields?.after_sentences, "5");
	assert.equal(status().pending, false);
});
