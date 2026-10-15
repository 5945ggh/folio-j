import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { commitSettingsResponse, settingsQueryKey } from "./settings-cache.ts";

test("a late settings GET cannot overwrite a successful PATCH or its accepted draft", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	});
	const old = { profile: { level_note: "old" } };
	const saved = { profile: { level_note: "saved" } };
	client.setQueryData(settingsQueryKey, old);
	let release: ((value: typeof old) => void) | undefined;
	const refresh = client
		.fetchQuery({
			queryKey: settingsQueryKey,
			queryFn: () =>
				new Promise<typeof old>((resolve) => {
					release = resolve;
				}),
		})
		.catch(() => undefined);
	let accepted = false;
	await commitSettingsResponse(client, saved, () => {
		assert.deepEqual(client.getQueryData(settingsQueryKey), saved);
		accepted = true;
	});
	assert.equal(accepted, true);
	assert.ok(release);
	release(old);
	await refresh;
	assert.deepEqual(client.getQueryData(settingsQueryKey), saved);
	client.clear();
});
