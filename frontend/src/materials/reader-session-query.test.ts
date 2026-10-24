import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { refreshReaderSessionQuery } from "./reader-session-query.ts";

for (const cached of [false, true]) {
	test(`resume cancels an old response before refreshing, cached data: ${cached}`, async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, gcTime: Infinity } },
		});
		const key = ["reader-records", "chapter"] as const;
		const other = ["reader-records", "another-chapter"] as const;
		client.setQueryData(other, ["untouched"]);
		if (cached) client.setQueryData(key, ["deleted record"]);
		let finishOld: (value: string[]) => void = () => {};
		let calls = 0;
		const observer = new QueryObserver(client, {
			queryKey: key,
			queryFn: () =>
				++calls === 1
					? new Promise<string[]>((resolve) => {
							finishOld = resolve;
						})
					: Promise.resolve(["fresh record"]),
		});
		const unsubscribe = observer.subscribe(() => {});
		assert.equal(calls, 1);
		observer.setOptions({ ...observer.options, enabled: false });
		await refreshReaderSessionQuery(
			client,
			key,
			() => observer.refetch({ cancelRefetch: false }),
			() => true,
		);
		assert.equal(calls, 2);
		assert.deepEqual(client.getQueryData(key), ["fresh record"]);
		finishOld(["deleted record"]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(client.getQueryData(key), ["fresh record"]);
		assert.deepEqual(client.getQueryData(other), ["untouched"]);
		unsubscribe();
		client.clear();
	});
}

test("a superseded refresh ticket does not start another request after cancellation", async () => {
	const client = new QueryClient();
	let current = true;
	let refetched = false;
	const work = refreshReaderSessionQuery(
		client,
		["records"],
		async () => {
			refetched = true;
		},
		() => current,
	);
	current = false;
	await work;
	assert.equal(refetched, false);
	client.clear();
});

test("a resumed cached observer fetches once for the session and still responds to mutation invalidation", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	});
	const key = ["reader-records", "scheduling"];
	let calls = 0;
	client.setQueryData(key, ["cached"]);
	const options = {
		queryKey: key,
		queryFn: async () => {
			calls++;
			return ["fresh"];
		},
		staleTime: Infinity,
		enabled: false,
	};
	const observer = new QueryObserver(client, options);
	const unsubscribe = observer.subscribe(() => {});
	observer.setOptions({ ...options, enabled: true });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(calls, 0);
	await refreshReaderSessionQuery(
		client,
		key,
		() => observer.refetch(),
		() => true,
	);
	assert.equal(calls, 1);
	assert.deepEqual(client.getQueryData(key), ["fresh"]);
	await client.invalidateQueries({ queryKey: key, exact: true });
	assert.equal(calls, 2);
	unsubscribe();
	client.clear();
});
