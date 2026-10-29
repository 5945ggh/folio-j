import assert from "node:assert/strict";
import test from "node:test";
import {
	cancelReaderSessionReads,
	canResumeReader,
	readerSessionIdentity,
} from "./reader-session.ts";

const identity = { materialId: "book", versionId: "v1", generationId: "g1" };
test("segment navigation does not change a reader's content identity", () => {
	assert.equal(readerSessionIdentity(identity), "book:v1:g1");
	assert.equal(canResumeReader(identity, identity, 4, 4), true);
});
test("a changed version, reading generation, material or external CAS revision replaces the session", () => {
	for (const change of [
		{ materialId: "other" },
		{ versionId: "v2" },
		{ generationId: "g2" },
	])
		assert.equal(
			canResumeReader(identity, { ...identity, ...change }, 4, 4),
			false,
		);
	assert.equal(canResumeReader(identity, identity, 4, 5), false);
});
test("a completed local write is compared using its drained revision", () => {
	assert.equal(canResumeReader(identity, identity, 7, 7), true);
	assert.equal(canResumeReader(identity, identity, 6, 7), false);
});

test("late frame readiness during suspension waits for a visible surface before restoring", async () => {
	const { ReaderLayout } = await import("./reader-layout.ts");
	const anchor = { offset: 350 };
	const layout = new ReaderLayout(anchor);
	let active = true;
	let measured = 0;
	let restored = 0;
	const surface = {
		generation: 1,
		parts: 1,
		geometry: "same-document",
		size: () => (active ? { width: 800, height: 600 } : null),
		capture: () => anchor,
		measure: () => {
			measured++;
		},
		restore: (target: typeof anchor | null) => {
			assert.equal(target, anchor);
			restored++;
			return () => {};
		},
	};
	layout.commit(
		surface,
		() => {},
		() => {},
	);
	const beforePause = measured;
	active = false;
	layout.cancelSave();
	layout.resourcesReady(1, 0);
	layout.reflow();
	assert.equal(measured, beforePause);
	assert.equal(restored, 0);
	active = true;
	layout.commit(
		surface,
		() => {},
		() => {},
	);
	assert.equal(restored, 1);
});

test("a stopped writer requires a new session even when its CAS revision still matches", async () => {
	const { PositionQueue } = await import("./position.ts");
	let healthy = true;
	const queue = new PositionQueue(
		7,
		async (_position: number) => {
			throw new Error("offline");
		},
		(state) => {
			if (state === "error") healthy = false;
		},
	);
	queue.enqueue(350);
	await queue.flush();
	assert.equal(queue.revision, 7);
	assert.equal(
		canResumeReader(identity, identity, queue.revision, 7, healthy),
		false,
	);
});

test("suspending a visible search expires its marker and cannot revive it on resume", async () => {
	const { NavigationHighlightLifetime } = await import(
		"./navigation-highlight.ts"
	);
	let marker = false;
	let lateDeadline = () => {};
	const lifetime = new NavigationHighlightLifetime(
		() => {
			marker = false;
		},
		(deadline) => {
			lateDeadline = deadline;
			return () => {};
		},
	);
	marker = true;
	lifetime.replace();
	lifetime.presented();
	lifetime.clear(true);
	lifetime.dispose();
	assert.equal(marker, false);
	lateDeadline();
	lifetime.presented();
	assert.equal(marker, false);
});

for (const deletedOrigin of [false, true]) {
	test(`opening cancels the previous activation's book and origin reads, deleted origin: ${deletedOrigin}`, async () => {
		const { QueryClient } = await import("@tanstack/react-query");
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, gcTime: Infinity } },
		});
		const bookKey = ["materials", "book"] as const;
		const originKey = ["segments", "segment", "material-provenance"] as const;
		let bookCalls = 0;
		let originCalls = 0;
		let releaseOldBook: (value: { revision: number }) => void = () => {};
		let releaseOldOrigin: (value: { available: boolean }) => void = () => {};
		const oldBook = client
			.fetchQuery({
				queryKey: bookKey,
				queryFn: () => {
					bookCalls++;
					return new Promise<{ revision: number }>((resolve) => {
						releaseOldBook = resolve;
					});
				},
			})
			.catch(() => {});
		const oldOrigin = client
			.fetchQuery({
				queryKey: originKey,
				queryFn: () => {
					originCalls++;
					return new Promise<{ available: boolean }>((resolve) => {
						releaseOldOrigin = resolve;
					});
				},
			})
			.catch(() => {});
		assert.equal(bookCalls, 1);
		assert.equal(originCalls, 1);
		const current = await cancelReaderSessionReads(
			client,
			[bookKey, originKey],
			() => true,
		);
		assert.equal(current, true);
		const fresh = Promise.all([
			client.fetchQuery({
				queryKey: bookKey,
				staleTime: 0,
				queryFn: async () => {
					bookCalls++;
					return { revision: 8 };
				},
			}),
			client.fetchQuery({
				queryKey: originKey,
				staleTime: 0,
				queryFn: async () => {
					originCalls++;
					if (deletedOrigin) throw new Error("segment deleted");
					return { available: true };
				},
			}),
		]);
		if (deletedOrigin) await assert.rejects(fresh, /segment deleted/);
		else assert.deepEqual(await fresh, [{ revision: 8 }, { available: true }]);
		assert.equal(bookCalls, 2);
		assert.equal(originCalls, 2);
		releaseOldBook({ revision: 7 });
		releaseOldOrigin({ available: true });
		await Promise.all([oldBook, oldOrigin]);
		assert.deepEqual(client.getQueryData(bookKey), { revision: 8 });
		if (deletedOrigin) assert.equal(client.getQueryData(originKey), undefined);
		client.clear();
	});
}

test("opening's canceled activation cannot start reads after its cancellation gate", async () => {
	const { QueryClient } = await import("@tanstack/react-query");
	const client = new QueryClient();
	let current = true;
	const gate = cancelReaderSessionReads(
		client,
		[["materials", "book"]],
		() => current,
	);
	current = false;
	assert.equal(await gate, false);
	client.clear();
});
