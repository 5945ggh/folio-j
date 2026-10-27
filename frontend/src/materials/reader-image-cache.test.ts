import assert from "node:assert/strict";
import test from "node:test";
import { ReaderImageCache } from "./reader-image-cache.ts";

test("reader image bytes are reused within a session and released on close", async () => {
	const cache = new ReaderImageCache();
	const signal = new AbortController().signal;
	const source = "data:image/png;base64,aGVsbG8=";
	const first = await cache.get(source, signal);
	assert.equal(await first.text(), "hello");
	assert.equal(await cache.get(source, signal), first);
	cache.close();
	await assert.rejects(cache.get(source, signal));
});

test("a gallery occurrence reuses the trusted source already loaded in the reader", async () => {
	const cache = new ReaderImageCache();
	const signal = new AbortController().signal;
	const source = "data:image/png;base64,aGVsbG8=";
	cache.rememberSource("/gallery/1", source);
	const fromReader = await cache.get(source, signal);
	assert.equal(await cache.get("/gallery/1", signal), fromReader);
	cache.close();
});

test("an in-flight occurrence uses its latest source association before cache eviction", async () => {
	const cache = new ReaderImageCache();
	const original = globalThis.fetch;
	const source = "data:image/png;base64,aGVsbG8=";
	let release: (() => void) | undefined;
	globalThis.fetch = async (url) => {
		if (url === "/first") {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		}
		return new Response(new Blob([new Uint8Array(20 * 1024 * 1024)]));
	};
	try {
		const signal = new AbortController().signal;
		const pending = cache.get("/first", signal);
		cache.rememberSource("/first", source);
		release?.();
		const first = await pending;
		// Fail on stale-key insertion before exercising the eviction loop.
		assert.equal(await cache.get(source, signal), first);
		assert.equal(await cache.get("/first", signal), first);
		const second = await cache.get("/second", signal);
		assert.equal(await cache.get("/second", signal), second);
		assert.notEqual(await cache.get("/first", signal), first);
	} finally {
		globalThis.fetch = original;
		cache.close();
	}
});

test("associating an existing blob preserves its byte charge and alias deletion releases it", async () => {
	const cache = new ReaderImageCache();
	const original = globalThis.fetch;
	const source = "data:image/png;base64,aGVsbG8=";
	globalThis.fetch = async () =>
		new Response(new Blob([new Uint8Array(16 * 1024 * 1024)]));
	try {
		const signal = new AbortController().signal;
		const first = await cache.get("/first", signal);
		cache.rememberSource("/first", source);
		const second = await cache.get("/second", signal);
		assert.equal(await cache.get(source, signal), first);
		assert.equal(await cache.get("/first", signal), first);
		const third = await cache.get("/third", signal);
		assert.equal(await cache.get(source, signal), first);
		cache.delete("/first");
		assert.notEqual(await cache.get("/second", signal), second);
		assert.equal(await cache.get("/third", signal), third);
		assert.notEqual(await cache.get(source, signal), first);
	} finally {
		globalThis.fetch = original;
		cache.close();
	}
});

test("associating overlapping blobs keeps the source blob and charges it only once", async () => {
	const cache = new ReaderImageCache();
	const original = globalThis.fetch;
	const source = "data:image/png;base64,aGVsbG8=";
	globalThis.fetch = async () =>
		new Response(new Blob([new Uint8Array(20 * 1024 * 1024)]));
	try {
		const signal = new AbortController().signal;
		await cache.get("/first", signal);
		const fromReader = await cache.get(source, signal);
		cache.rememberSource("/first", source);
		assert.equal(await cache.get("/first", signal), fromReader);
		const second = await cache.get("/second", signal);
		assert.equal(await cache.get(source, signal), fromReader);
		assert.equal(await cache.get("/second", signal), second);
	} finally {
		globalThis.fetch = original;
		cache.close();
	}
});

test("failed or cancelled requests do not populate the cache", async () => {
	const cache = new ReaderImageCache();
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		cache.get("data:image/png;base64,aGVsbG8=", controller.signal),
	);
	await assert.rejects(
		cache.get(
			"data:image/svg+xml;base64,PHN2Zz4=",
			new AbortController().signal,
		),
	);
});

test("shared byte requests survive one cancelled waiter and are reused", async () => {
	const cache = new ReaderImageCache();
	const original = globalThis.fetch;
	let calls = 0;
	let release: (() => void) | undefined;
	globalThis.fetch = async () => {
		calls++;
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return new Response(new Blob(["image"], { type: "image/png" }));
	};
	try {
		const cancelled = new AbortController();
		const live = new AbortController();
		const first = cache.get("/image", cancelled.signal);
		const second = cache.get("/image", live.signal);
		cancelled.abort();
		await assert.rejects(first);
		release?.();
		const blob = await second;
		assert.equal(calls, 1);
		assert.equal(await cache.get("/image", live.signal), blob);
	} finally {
		globalThis.fetch = original;
		cache.close();
	}
});

test("least recently used image bytes are evicted under the memory budget", async () => {
	const cache = new ReaderImageCache();
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		return new Response(new Blob([new Uint8Array(20 * 1024 * 1024)]));
	};
	try {
		const signal = new AbortController().signal;
		await cache.get("/first", signal);
		await cache.get("/second", signal);
		await cache.get("/first", signal);
		assert.equal(calls, 3);
	} finally {
		globalThis.fetch = original;
		cache.close();
	}
});
