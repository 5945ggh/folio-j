import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { completeDraft, createDraft, editDraft } from "./draft.ts";
import {
	commitSegmentContextResponse,
	segmentContextKey,
} from "./segment-context-cache.ts";

const defaults = {
	enabled: true,
	before_sentences: 3,
	after_sentences: 3,
	before_characters: 200,
	after_characters: 200,
	revision: 0,
};

test("a late context GET cannot replace a saved group or alter other settings", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	});
	const general = { profile: { level_note: "unsaved elsewhere" } };
	client.setQueryData(["settings"], general);
	client.setQueryData(segmentContextKey, defaults);
	let release: ((value: typeof defaults) => void) | undefined;
	const refresh = client
		.fetchQuery({
			queryKey: segmentContextKey,
			queryFn: () =>
				new Promise<typeof defaults>((resolve) => {
					release = resolve;
				}),
		})
		.catch(() => undefined);
	const saved = {
		...defaults,
		enabled: false,
		before_sentences: 0,
		revision: 1,
	};
	let draft = editDraft(createDraft(defaults), saved);
	await commitSegmentContextResponse(client, saved, (persisted) => {
		draft = completeDraft(draft, saved, persisted);
	});
	assert.ok(release);
	release(defaults);
	await refresh;
	assert.deepEqual(client.getQueryData(segmentContextKey), saved);
	assert.deepEqual(client.getQueryData(["settings"]), general);
	assert.deepEqual(draft.value, saved);
	assert.equal(draft.saved, true);
	client.clear();
});

test("an older save response cannot replace a newer settings revision", async () => {
	const client = new QueryClient();
	const latest = { ...defaults, after_sentences: 8, revision: 3 };
	client.setQueryData(segmentContextKey, latest);
	let accepted = defaults;
	await commitSegmentContextResponse(
		client,
		{ ...defaults, revision: 2 },
		(persisted) => {
			accepted = persisted;
		},
	);
	assert.deepEqual(accepted, latest);
	assert.deepEqual(client.getQueryData(segmentContextKey), latest);
	client.clear();
});
