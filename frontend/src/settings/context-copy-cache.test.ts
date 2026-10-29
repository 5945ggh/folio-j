import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import type { ContextCopySettings } from "./context-copy-api.ts";
import {
	commitContextCopyResponse,
	contextCopyKey,
	newestContextCopySettings,
} from "./context-copy-cache.ts";

const defaults: ContextCopySettings = {
	before_sentences: 3,
	after_sentences: 0,
	before_characters: 200,
	after_characters: 200,
	include_source: true,
	revision: 0,
};

test("publishing saved copy settings cancels a late GET and leaves appearance and study settings alone", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	});
	const appearance = { theme: "black" };
	const study = { before_sentences: 8, revision: 3 };
	client.setQueryData(["reader-appearance"], appearance);
	client.setQueryData(["segment-context-settings"], study);
	client.setQueryData(contextCopyKey, defaults);
	let release: ((value: ContextCopySettings) => void) | undefined;
	const refresh = client
		.fetchQuery({
			queryKey: contextCopyKey,
			queryFn: () =>
				new Promise<ContextCopySettings>((resolve) => {
					release = resolve;
				}),
		})
		.catch(() => undefined);
	const saved = { ...defaults, before_sentences: 7, revision: 1 };
	assert.deepEqual(await commitContextCopyResponse(client, saved), saved);
	assert.ok(release);
	release(defaults);
	await refresh;
	assert.deepEqual(client.getQueryData(contextCopyKey), saved);
	assert.deepEqual(client.getQueryData(["reader-appearance"]), appearance);
	assert.deepEqual(client.getQueryData(["segment-context-settings"]), study);
	client.clear();
});

test("an older save response never replaces a newer cache revision", async () => {
	const client = new QueryClient();
	const latest = { ...defaults, include_source: false, revision: 4 };
	client.setQueryData(contextCopyKey, latest);
	assert.deepEqual(
		await commitContextCopyResponse(client, { ...defaults, revision: 3 }),
		latest,
	);
	assert.deepEqual(client.getQueryData(contextCopyKey), latest);
	client.clear();
});

test("a late read preserves the latest saved revision through the shared query merge", async () => {
	const client = new QueryClient();
	const latest = { ...defaults, after_sentences: 5, revision: 7 };
	client.setQueryData(contextCopyKey, latest);
	await client.fetchQuery({
		queryKey: contextCopyKey,
		queryFn: async () => ({ ...defaults, revision: 6 }),
		structuralSharing: (current, response) =>
			newestContextCopySettings(
				current as ContextCopySettings | undefined,
				response as ContextCopySettings,
			),
	});
	assert.deepEqual(client.getQueryData(contextCopyKey), latest);
	assert.deepEqual(newestContextCopySettings(undefined, defaults), defaults);
	client.clear();
});

test("cancelling an older GET retains a newer revision already published during that GET", async () => {
	const client = new QueryClient();
	client.setQueryData(contextCopyKey, defaults);
	let release: ((value: ContextCopySettings) => void) | undefined;
	const refresh = client
		.fetchQuery({
			queryKey: contextCopyKey,
			queryFn: () =>
				new Promise<ContextCopySettings>((resolve) => {
					release = resolve;
				}),
		})
		.catch(() => undefined);
	const newest = { ...defaults, before_sentences: 9, revision: 4 };
	client.setQueryData(contextCopyKey, newest);
	await commitContextCopyResponse(client, { ...defaults, revision: 3 });
	assert.ok(release);
	release(defaults);
	await refresh;
	assert.deepEqual(client.getQueryData(contextCopyKey), newest);
	client.clear();
});
