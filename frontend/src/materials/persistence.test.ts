import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
	cacheSavedPosition,
	registerPositionWriter,
	waitForPositionWrites,
} from "./persistence.ts";
import { PositionQueue } from "./position.ts";

test("return visit waits for final queued writes and mounts from fresh revision with real QueryClient", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	type Snapshot = {
		reading_position: {
			revision: number;
			offset: number;
			writing_mode: string;
		};
	};
	let server: Snapshot = {
		reading_position: { revision: 1, offset: 0, writing_mode: "horizontal-tb" },
	};
	const key = ["materials", "return-book"];
	client.setQueryData(key, server);
	let first: () => void = () => {},
		second: () => void = () => {};
	const firstGate = new Promise<void>((resolve) => {
		first = resolve;
	});
	const secondGate = new Promise<void>((resolve) => {
		second = resolve;
	});
	const queue = new PositionQueue<number>(
		1,
		async (value, revision) => {
			assert.equal(revision, server.reading_position.revision);
			await (value === 800 ? firstGate : secondGate);
			server = {
				reading_position: {
					revision: revision + 1,
					offset: value,
					writing_mode: "vertical-rl",
				},
			};
			cacheSavedPosition<Snapshot>(
				client,
				"return-book",
				server.reading_position,
			);
			return server.reading_position.revision;
		},
		() => {},
	);
	const unregister = registerPositionWriter("return-book", queue);
	queue.enqueue(800);
	queue.enqueue(895);
	unregister();
	const fetchSnapshot = async () => {
		await waitForPositionWrites("return-book");
		return server;
	};
	const observer = new QueryObserver(client, {
		queryKey: key,
		queryFn: fetchSnapshot,
		refetchOnMount: "always",
	});
	assert.equal(observer.getCurrentResult().isFetchedAfterMount, false);
	const unsubscribe = observer.subscribe(() => {});
	const opening = client.fetchQuery({ queryKey: key, queryFn: fetchSnapshot });
	first();
	await new Promise((resolve) => setTimeout(resolve, 0));
	// A cache update counts as fetched after mount, but the opening GET is still waiting for the last write.
	assert.equal(observer.getCurrentResult().isFetchedAfterMount, true);
	assert.equal(observer.getCurrentResult().isFetching, true);
	assert.equal(
		client.getQueryData<Snapshot>(key)?.reading_position.revision,
		2,
	);
	second();
	const latest = await opening;
	assert.deepEqual(latest.reading_position, {
		revision: 3,
		offset: 895,
		writing_mode: "vertical-rl",
	});
	assert.equal(observer.getCurrentResult().isFetching, false);
	const reopened = new PositionQueue<number>(
		latest.reading_position.revision,
		async (value, revision) => {
			assert.equal(value, 900);
			assert.equal(revision, 3);
			return revision + 1;
		},
		() => {},
	);
	reopened.enqueue(900);
	await reopened.flush();
	assert.equal(reopened.revision, 4);
	unsubscribe();
	client.clear();
});

test("cleanup of old reader cannot unregister a newly mounted writer", async () => {
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const disposeOld = registerPositionWriter("registration", {
		flush: () => gate,
	});
	disposeOld();
	let latestFlushed = false;
	const disposeNew = registerPositionWriter("registration", {
		flush: async () => {
			latestFlushed = true;
		},
	});
	release();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await waitForPositionWrites("registration");
	assert.equal(latestFlushed, true);
	disposeNew();
});
