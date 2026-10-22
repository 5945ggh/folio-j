import assert from "node:assert/strict";
import test from "node:test";
import type { Chapter, Position, Settings } from "./api.ts";
import { ReaderLayout } from "./reader-layout.ts";
import {
	ReaderNavigation,
	type ReaderNavigationContext,
	type ReaderNavigationDestination,
	type ReaderNavigationState,
} from "./reader-navigation.ts";
import { JumpReadingSession } from "./return-origin.ts";

const settings: Settings = {
	font_size: 26,
	line_height: 2.2,
	writing_mode: "vertical-rl",
};
function position(chapterId: string, offset = 40): Position {
	return {
		version_id: "v",
		chapter_id: chapterId,
		part_index: 0,
		resource_id: `r-${chapterId}`,
		kind: "text",
		offset,
		at_chapter_end: false,
		settings,
	};
}
function chapter(id: string): Chapter {
	return {
		id,
		material_id: "book",
		version_id: "v",
		title: id,
		level: 1,
		parts: [
			{
				resource_id: `r-${id}`,
				spine_index: 2,
				start: 0,
				end: 100,
				leaf_start: 0,
				leaf_end: 1,
				html: '<p>本文</p><img data-epub-image="7">',
			},
		],
		resources: [],
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

type Completion = Parameters<ReaderNavigationContext["present"]>[1];
function fixture(reading = new JumpReadingSession(), initiallyReady = true) {
	const navigation = new ReaderNavigation(reading);
	const loads: string[] = [];
	const saved: Position[] = [];
	const closed: ("left" | "right" | "all")[] = [];
	const snapshots: ReaderNavigationState[] = [];
	const presentations: {
		destination: ReaderNavigationDestination | null;
		complete: Completion;
	}[] = [];
	const remembered = new Map<string, Position>();
	const chapters = ["A", "B", "C", "D"].map((id) => ({ id, title: id }));
	let currentChapter = "A";
	let currentSettings = settings;
	let captured: Position | null = position("A");
	let progress: number | null = 0.4;
	let physicalStart = false;
	let unavailable = false;
	let loader = async (id: string) => chapter(id);
	const context = (): ReaderNavigationContext => ({
		versionId: "v",
		chapterId: currentChapter,
		chapters,
		settings: currentSettings,
		remembered: (id) => remembered.get(id),
		presentedAnchor: () => captured,
		progressFor: () => progress,
		atBeginning: () => physicalStart,
		loadChapter: (id) => {
			loads.push(id);
			return loader(id);
		},
		saveDeparture: (anchor) => saved.push(anchor),
		present: (destination, complete) => {
			presentations.push({ destination, complete });
			if (destination) currentChapter = destination.target.chapter_id;
		},
		closePanels: (side) => closed.push(side ?? "all"),
		changed: (snapshot) => snapshots.push(snapshot),
		unavailable,
	});
	const bind = () => navigation.bind(context());
	const complete = (
		index = presentations.length - 1,
		located = true,
		anchor?: Position | null,
	) => {
		const presentation = presentations[index];
		assert.ok(presentation);
		const result =
			anchor === undefined
				? (presentation.destination?.target ?? captured)
				: anchor;
		if (located && index === presentations.length - 1) {
			captured = result;
			physicalStart = presentation.destination?.beginning ?? physicalStart;
		}
		presentation.complete({ anchor: result, located });
	};
	bind();
	if (initiallyReady) complete();
	return {
		navigation,
		loads,
		saved,
		closed,
		snapshots,
		presentations,
		remembered,
		chapters,
		setProgress(next: number | null) {
			progress = next;
			bind();
		},
		bind,
		complete,
		setLoader(next: typeof loader) {
			loader = next;
		},
		setCaptured(next: Position | null) {
			captured = next;
		},
		setPhysicalStart(next: boolean) {
			physicalStart = next;
		},
		setSettings(next: Settings) {
			currentSettings = next;
			bind();
		},
		setUnavailable(next: boolean) {
			unavailable = next;
			bind();
		},
		setChapter(next: string) {
			currentChapter = next;
			bind();
		},
		async navigate(...args: Parameters<ReaderNavigation["navigate"]>) {
			const accepted = await navigation.navigate(...args);
			bind();
			return accepted;
		},
	};
}

test("directory, search and image jumps preserve the first stable origin", async () => {
	const f = fixture();
	assert.equal(await f.navigate({ type: "chapter", id: "B" }), true);
	assert.equal(
		await f.navigate({
			type: "position",
			target: position("C", 60),
			mark: { start: 60, end: 65 },
		}),
		true,
	);
	assert.equal(
		await f.navigate({
			type: "position",
			target: {
				...position("D"),
				kind: "image",
				image_id: 7,
				image_progress: 0.5,
			},
		}),
		true,
	);
	assert.deepEqual(f.navigation.state.origin, position("A"));
	assert.equal(f.presentations.at(-1)?.destination?.target.kind, "image");
	assert.deepEqual(f.presentations[2]?.destination?.mark, {
		start: 60,
		end: 65,
	});
	assert.deepEqual(f.saved, [position("A"), position("A"), position("A")]);
});

test("return progress stays with its origin through later reading, failed returns and retry", async () => {
	const f = fixture();
	assert.equal(f.navigation.state.originProgress, null);
	f.setProgress(0.424);
	await f.navigate({ type: "chapter", id: "B" });
	f.complete();
	f.setCaptured(position("B", 80));
	f.setProgress(0.8);
	await f.navigate({ type: "chapter", id: "C" });
	assert.deepEqual(f.navigation.state.origin, position("A"));
	assert.equal(f.navigation.state.originProgress, 0.424);
	await f.navigate({ type: "return" });
	f.complete(undefined, false);
	assert.equal(f.navigation.state.originProgress, 0.424);
	await f.navigate({ type: "return" });
	f.complete();
	assert.equal(f.navigation.state.origin, null);
	assert.equal(f.navigation.state.originProgress, null);
});

test("beginning snapshots zero, chapter-end and unavailable progress for its new origin", async () => {
	for (const progress of [0, 1, null]) {
		const f = fixture();
		await f.navigate({ type: "chapter", id: "B" });
		f.complete();
		f.setCaptured(position("B", 60));
		f.setPhysicalStart(false);
		f.setProgress(progress);
		await f.navigate({ type: "beginning" });
		assert.deepEqual(f.navigation.state.origin, position("B", 60));
		assert.equal(f.navigation.state.originProgress, progress);
	}
});

test("out-of-order chapter loads accept only the latest request", async () => {
	const f = fixture();
	const b = deferred<Chapter>();
	const c = deferred<Chapter>();
	f.setLoader((id) => (id === "B" ? b.promise : c.promise));
	const first = f.navigation.navigate({ type: "chapter", id: "B" });
	const last = f.navigation.navigate({ type: "chapter", id: "C" });
	c.resolve(chapter("C"));
	assert.equal(await last, true);
	b.resolve(chapter("B"));
	assert.equal(await first, false);
	assert.equal(f.presentations.length, 2);
	assert.equal(f.presentations[1]?.destination?.target.chapter_id, "C");
	assert.deepEqual(f.navigation.state.origin, position("A"));
});

test("adjacent navigation remains locked while loading and until stable presentation", async () => {
	const f = fixture();
	const load = deferred<Chapter>();
	f.setLoader(() => load.promise);
	const pending = f.navigation.navigate({
		type: "adjacent",
		direction: "next",
	});
	assert.equal(f.navigation.state.busy, true);
	assert.equal(
		await f.navigation.navigate({ type: "adjacent", direction: "next" }),
		false,
	);
	f.complete(0);
	assert.equal(f.navigation.state.busy, true);
	load.resolve(chapter("B"));
	assert.equal(await pending, true);
	f.bind();
	assert.equal(f.navigation.state.busy, true);
	assert.equal(
		await f.navigate({ type: "adjacent", direction: "next" }),
		false,
	);
	assert.equal(f.loads.length, 1);
	f.complete();
	assert.equal(f.navigation.state.busy, false);
	assert.equal(f.navigation.state.adjacentDisabled, false);
});

test("initial and arbitrary accepted surfaces disable adjacent navigation until completion", async () => {
	const f = fixture(undefined, false);
	assert.equal(f.navigation.state.adjacentDisabled, true);
	assert.equal(
		await f.navigate({ type: "adjacent", direction: "next" }),
		false,
	);
	f.complete();
	assert.equal(
		await f.navigate({ type: "position", target: position("B") }),
		true,
	);
	assert.equal(f.navigation.state.busy, false);
	assert.equal(f.navigation.state.adjacentDisabled, true);
	f.complete();
	assert.equal(f.navigation.state.adjacentDisabled, false);
});

test("ReaderLayout releases the adjacent lock only after all resources and restoration", async () => {
	const f = fixture();
	await f.navigate({ type: "adjacent", direction: "next" });
	const receipt = f.presentations.at(-1);
	assert.ok(receipt?.destination);
	const layout = new ReaderLayout(receipt.destination.target);
	const size = { width: 760, height: 800 };
	layout.commit(
		{
			generation: 1,
			parts: 2,
			geometry: "vertical",
			size: () => size,
			capture: () => receipt.destination?.target ?? null,
			measure: () => {},
			restore: (anchor) => () => receipt.complete({ anchor, located: true }),
		},
		() => {},
		() => {},
	);
	layout.resourcesReady(1, 0);
	assert.equal(f.navigation.state.busy, true);
	assert.equal(layout.canSample(size), false);
	layout.resourcesReady(1, 1);
	assert.equal(layout.canSample(size), true);
	assert.equal(f.navigation.state.busy, false);
});

test("failed chapter load releases the adjacent lock and permits retry", async () => {
	const f = fixture();
	f.setLoader(async () => {
		throw new Error("failed");
	});
	assert.equal(
		await f.navigate({ type: "adjacent", direction: "next" }),
		false,
	);
	assert.equal(f.navigation.state.busy, false);
	assert.equal(f.navigation.state.adjacentDisabled, false);
	assert.match(f.navigation.state.error?.message ?? "", /failed/);
	assert.equal(f.navigation.state.origin, null);
	assert.equal(f.saved.length, 0);
	f.setLoader(async (id) => chapter(id));
	assert.equal(await f.navigate({ type: "adjacent", direction: "next" }), true);
	assert.equal(f.navigation.state.error, null);
});

test("return failure retains the origin and a located retry consumes it", async () => {
	const f = fixture();
	await f.navigate({ type: "chapter", id: "B" });
	f.complete();
	const origin = f.navigation.state.origin;
	assert.equal(await f.navigate({ type: "return" }), true);
	assert.equal(f.navigation.state.returning, true);
	f.complete(undefined, false);
	assert.deepEqual(f.navigation.state.origin, origin);
	assert.equal(f.navigation.state.returning, false);
	assert.match(f.navigation.state.error?.message ?? "", /已保留返回点/);
	assert.equal(await f.navigate({ type: "return" }), true);
	f.complete();
	assert.equal(f.navigation.state.origin, null);
	assert.equal(f.navigation.state.error, null);
	assert.equal(f.navigation.state.returning, false);
});

test("accepted returns close both panels while failed loads leave them open", async () => {
	const f = fixture();
	await f.navigate({ type: "chapter", id: "B" });
	f.complete();
	assert.deepEqual(f.closed, []);
	f.setLoader(async () => {
		throw new Error("failed");
	});
	assert.equal(await f.navigate({ type: "return" }), false);
	assert.deepEqual(f.closed, []);
	f.setLoader(async (id) => chapter(id));
	assert.equal(await f.navigate({ type: "return" }), true);
	assert.deepEqual(f.closed, ["all"]);
});

test("a return requires its exact text target even when restoration reports located", async () => {
	for (const anchor of [
		null,
		position("A", 41),
		{ ...position("A"), resource_id: "other" },
		position("B"),
	]) {
		const f = fixture();
		await f.navigate({ type: "chapter", id: "B" });
		f.complete();
		await f.navigate({ type: "return" });
		f.complete(undefined, true, anchor);
		assert.deepEqual(f.navigation.state.origin, position("A"));
	}
});

test("an image return requires its image and tolerates current presentation settings", async () => {
	const f = fixture();
	const image: Position = {
		...position("A"),
		kind: "image",
		image_id: 7,
		image_progress: 0.5,
	};
	f.setCaptured(image);
	await f.navigate({ type: "chapter", id: "B" });
	f.complete();
	await f.navigate({ type: "return" });
	f.complete(undefined, true, { ...image, image_id: 8 });
	assert.deepEqual(f.navigation.state.origin, image);
	await f.navigate({ type: "return" });
	f.complete(undefined, true, {
		...image,
		settings: { ...settings, font_size: 32 },
	});
	assert.equal(f.navigation.state.origin, null);
});

test("same-chapter directory selection invalidates pending requests without requesting a surface", async () => {
	const f = fixture();
	const load = deferred<Chapter>();
	f.setLoader(() => load.promise);
	const pending = f.navigation.navigate({ type: "chapter", id: "B" });
	assert.equal(await f.navigate({ type: "chapter", id: "A" }, "left"), false);
	load.resolve(chapter("B"));
	assert.equal(await pending, false);
	assert.equal(f.loads.length, 1);
	assert.equal(f.presentations.length, 1);
	assert.deepEqual(f.closed, ["left"]);
});

test("explicit beginning uses physical start and preserves undo on exact repeats", async () => {
	const f = fixture();
	assert.equal(await f.navigate({ type: "beginning" }), true);
	assert.deepEqual(f.navigation.state.origin, position("A"));
	assert.equal(f.presentations.at(-1)?.destination?.beginning, true);
	f.complete();
	f.setCaptured(position("A", 1));
	assert.equal(await f.navigate({ type: "beginning" }), false);
	assert.deepEqual(f.navigation.state.origin, position("A"));
	assert.equal(f.presentations.length, 2);
	f.setPhysicalStart(false);
	assert.equal(await f.navigate({ type: "beginning" }), true);
	assert.deepEqual(f.navigation.state.origin, position("A", 1));
});

test("explicit beginning replaces an earlier chapter origin with the current presented anchor", async () => {
	const f = fixture();
	await f.navigate({ type: "chapter", id: "B" });
	f.complete();
	f.setCaptured(position("B", 60));
	f.setPhysicalStart(false);
	assert.equal(await f.navigate({ type: "beginning" }), true);
	assert.deepEqual(f.navigation.state.origin, position("B", 60));
});

test("a deferred destination and remembered position adopt the latest settings", async () => {
	const f = fixture();
	const saved = { ...position("B", 70), at_chapter_end: true };
	f.remembered.set("B", saved);
	const load = deferred<Chapter>();
	f.setLoader(() => load.promise);
	const pending = f.navigation.navigate({ type: "chapter", id: "B" });
	const current: Settings = {
		...settings,
		font_size: 32,
		writing_mode: "horizontal-tb",
	};
	f.setSettings(current);
	load.resolve(chapter("B"));
	assert.equal(await pending, true);
	assert.deepEqual(f.presentations.at(-1)?.destination, {
		target: { ...saved, settings: current },
		beginning: false,
	});
	assert.equal(saved.settings, settings);
});

test("new image-only chapters start at their first image and mixed chapters use text", async () => {
	for (const imageOnly of [false, true]) {
		const f = fixture();
		f.setLoader(async (id) => {
			const data = chapter(id);
			if (imageOnly) {
				const part = data.parts[0];
				assert.ok(part);
				part.end = part.start;
			}
			return data;
		});
		await f.navigate({ type: "chapter", id: "B" });
		const destination = f.presentations.at(-1)?.destination;
		assert.equal(destination?.beginning, true);
		assert.equal(destination?.target.kind, imageOnly ? "image" : "text");
		if (imageOnly) assert.equal(destination?.target.image_id, 7);
		else assert.equal(destination?.target.offset, 0);
	}
});

test("empty chapters and invalid targets preserve the current surface and origin", async () => {
	const invalid = [
		{ ...position("B"), version_id: "old" },
		{ ...position("B"), resource_id: "wrong" },
		{ ...position("B"), part_index: 2 },
		position("B", -1),
		position("B", 101),
		{ ...position("B"), kind: "image" as const, image_id: 99 },
	];
	for (const target of invalid) {
		const f = fixture();
		assert.equal(await f.navigate({ type: "position", target }), false);
		assert.ok(f.navigation.state.error);
		assert.equal(f.navigation.state.origin, null);
		assert.equal(f.presentations.length, 1);
		assert.deepEqual(f.saved, []);
	}
	const f = fixture();
	f.setLoader(async (id) => ({ ...chapter(id), parts: [] }));
	assert.equal(await f.navigate({ type: "chapter", id: "B" }), false);
	assert.match(f.navigation.state.error?.message ?? "", /章节没有可阅读内容/);
});

test("tool cancellation ignores late loads and releases the adjacent request lock", async () => {
	const f = fixture();
	const load = deferred<Chapter>();
	f.setLoader(() => load.promise);
	const pending = f.navigation.navigate({
		type: "adjacent",
		direction: "next",
	});
	f.navigation.invalidate();
	assert.equal(f.navigation.state.busy, false);
	load.resolve(chapter("B"));
	assert.equal(await pending, false);
	assert.equal(f.presentations.length, 1);
	assert.equal(f.navigation.state.origin, null);
});

test("new request intent does not revoke an already accepted surface completion", async () => {
	const f = fixture();
	await f.navigate({ type: "adjacent", direction: "next" });
	const accepted = f.presentations.length - 1;
	const load = deferred<Chapter>();
	f.setLoader(() => load.promise);
	const pending = f.navigation.navigate({ type: "chapter", id: "C" });
	f.complete(accepted);
	assert.equal(f.navigation.state.adjacentDisabled, false);
	load.reject(new Error("late failure"));
	assert.equal(await pending, false);
	assert.equal(f.navigation.state.adjacentDisabled, false);
});

test("old presentation completions cannot finish a newer accepted surface or consume its origin", async () => {
	const f = fixture();
	await f.navigate({ type: "chapter", id: "B" });
	f.complete();
	await f.navigate({ type: "return" });
	const returning = f.presentations.length - 1;
	await f.navigate({ type: "chapter", id: "C" });
	f.complete(returning);
	assert.deepEqual(f.navigation.state.origin, position("A"));
	assert.equal(f.navigation.state.adjacentDisabled, true);
	f.complete();
	assert.equal(f.navigation.state.adjacentDisabled, false);
});

test("suspend ignores late load and presentation callbacks and rebind requires a fresh surface", async () => {
	const f = fixture();
	await f.navigate({ type: "chapter", id: "B" });
	const old = f.presentations.length - 1;
	const load = deferred<Chapter>();
	f.setLoader(() => load.promise);
	const pending = f.navigation.navigate({ type: "chapter", id: "C" });
	f.navigation.suspend();
	f.complete(old);
	load.resolve(chapter("C"));
	assert.equal(await pending, false);
	const before = f.presentations.length;
	f.bind();
	assert.equal(f.presentations.length, before + 1);
	assert.equal(f.presentations.at(-1)?.destination, null);
	assert.equal(f.navigation.state.adjacentDisabled, true);
	f.complete(old);
	assert.equal(f.navigation.state.adjacentDisabled, true);
	f.complete();
	assert.equal(f.navigation.state.adjacentDisabled, false);
});

test("fresh binds preserve a pending surface receipt instead of replacing it", async () => {
	const f = fixture();
	await f.navigate({ type: "chapter", id: "B" });
	const count = f.presentations.length;
	f.bind();
	f.setSettings({ ...settings, font_size: 30 });
	assert.equal(f.presentations.length, count);
	assert.equal(f.navigation.state.adjacentDisabled, true);
	f.complete();
	assert.equal(f.navigation.state.adjacentDisabled, false);
});

test("confirmed reading replaces only the next accepted jump origin", async () => {
	const reading = new JumpReadingSession();
	const f = fixture(reading);
	await f.navigate({ type: "chapter", id: "B" });
	f.complete();
	f.setCaptured(position("B", 60));
	f.setProgress(0.6);
	f.setPhysicalStart(false);
	reading.sample(0, 1_000, 0);
	reading.input(100);
	reading.sample(500, 1_000, 100);
	reading.input(5_100);
	reading.sample(1_000, 1_000, 5_100);
	assert.equal(reading.shouldReplace, true);
	await f.navigate({ type: "chapter", id: "C" });
	assert.deepEqual(f.navigation.state.origin, position("B", 60));
	assert.equal(f.navigation.state.originProgress, 0.6);
	assert.equal(reading.shouldReplace, false);
	f.setProgress(0.9);
	await f.navigate({ type: "position", target: position("D") });
	assert.deepEqual(f.navigation.state.origin, position("B", 60));
	assert.equal(f.navigation.state.originProgress, 0.6);
});

test("missing stable capture preserves an existing return point", async () => {
	const f = fixture();
	await f.navigate({ type: "chapter", id: "B" });
	f.setCaptured(null);
	await f.navigate({ type: "chapter", id: "C" });
	assert.deepEqual(f.navigation.state.origin, position("A"));
	assert.equal(f.saved.length, 1);
});

test("neighbours follow source chapter order and never wrap", () => {
	const f = fixture();
	const state = () => f.navigation.state;
	assert.deepEqual(state().previous, null);
	assert.equal(state().next?.id, "B");
	f.setChapter("B");
	assert.equal(state().previous?.id, "A");
	assert.equal(state().next?.id, "C");
	f.setChapter("D");
	assert.equal(state().next, null);
	f.setChapter("unknown");
	assert.equal(state().previous, null);
	assert.equal(state().next, null);
});

test("unavailable surfaces disable adjacent actions and dismissal only clears the error", async () => {
	const f = fixture();
	f.setUnavailable(true);
	assert.equal(
		await f.navigate({ type: "adjacent", direction: "next" }),
		false,
	);
	assert.equal(f.loads.length, 0);
	f.setUnavailable(false);
	f.setLoader(async () => {
		throw new Error("load failed");
	});
	await f.navigate({ type: "chapter", id: "B" });
	assert.ok(f.navigation.state.error);
	f.navigation.dismissError();
	assert.equal(f.navigation.state.error, null);
	assert.equal(f.navigation.state.origin, null);
	assert.equal(f.presentations.length, 1);
});

test("repeated binds with unchanged state do not publish snapshots", () => {
	const f = fixture();
	const count = f.snapshots.length;
	for (let index = 0; index < 10; index++) f.bind();
	assert.equal(f.snapshots.length, count);
	f.setSettings({ ...settings, font_size: 30 });
	assert.equal(f.snapshots.length, count);
});

test("suspended failures cannot surface errors after a fresh bind", async () => {
	const f = fixture();
	const load = deferred<Chapter>();
	f.setLoader(() => load.promise);
	const pending = f.navigation.navigate({
		type: "adjacent",
		direction: "next",
	});
	f.navigation.suspend();
	f.bind();
	f.complete();
	const before = f.snapshots.length;
	load.reject(new Error("obsolete failure"));
	assert.equal(await pending, false);
	assert.equal(f.navigation.state.error, null);
	assert.equal(f.navigation.state.adjacentDisabled, false);
	assert.equal(f.snapshots.length, before);
});

test("a superseded request failure cannot clear a newer adjacent lock", async () => {
	const f = fixture();
	const oldLoad = deferred<Chapter>();
	const newLoad = deferred<Chapter>();
	f.setLoader((id) => (id === "C" ? oldLoad.promise : newLoad.promise));
	const old = f.navigation.navigate({ type: "chapter", id: "C" });
	const current = f.navigation.navigate({
		type: "adjacent",
		direction: "next",
	});
	oldLoad.reject(new Error("obsolete failure"));
	assert.equal(await old, false);
	assert.equal(f.navigation.state.busy, true);
	assert.equal(f.navigation.state.error, null);
	newLoad.resolve(chapter("B"));
	assert.equal(await current, true);
	assert.equal(f.navigation.state.busy, true);
	f.complete();
	assert.equal(f.navigation.state.busy, false);
});

test("chapter boundaries reject adjacent actions without loads or wrapping", async () => {
	const f = fixture();
	assert.equal(
		await f.navigate({ type: "adjacent", direction: "previous" }),
		false,
	);
	f.setChapter("D");
	assert.equal(
		await f.navigate({ type: "adjacent", direction: "next" }),
		false,
	);
	f.chapters.splice(0);
	f.bind();
	assert.equal(
		await f.navigate({ type: "adjacent", direction: "next" }),
		false,
	);
	assert.equal(f.loads.length, 0);
});

test("remembered text and image positions retain their location and chapter-end intent", async () => {
	for (const atEnd of [false, true]) {
		for (const image of [false, true]) {
			const f = fixture();
			const anchor: Position = {
				...position("B", 70),
				at_chapter_end: atEnd,
				...(image ? { kind: "image", image_id: 7, image_progress: 0.6 } : {}),
			};
			const original = structuredClone(anchor);
			f.remembered.set("B", anchor);
			await f.navigate({ type: "chapter", id: "B" });
			assert.deepEqual(f.presentations.at(-1)?.destination, {
				target: anchor,
				beginning: false,
			});
			assert.deepEqual(anchor, original);
			f.complete();
			f.setPhysicalStart(false);
			await f.navigate({ type: "beginning" });
			assert.equal(f.presentations.at(-1)?.destination?.beginning, true);
			assert.equal(f.presentations.at(-1)?.destination?.target.kind, "text");
			assert.equal(f.presentations.at(-1)?.destination?.target.offset, 0);
			assert.equal(
				f.presentations.at(-1)?.destination?.target.at_chapter_end,
				false,
			);
		}
	}
});

test("the previous surface can finish and save while an adjacent chapter is still loading", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	const load = deferred<Chapter>();
	f.setLoader(() => load.promise);
	const pending = f.navigation.navigate({
		type: "adjacent",
		direction: "next",
	});
	const anchor = position("A");
	const initial = f.presentations[0];
	assert.ok(initial);
	const layout = new ReaderLayout(anchor);
	const persisted: Position[] = [];
	const size = { width: 760, height: 800 };
	layout.commit(
		{
			generation: 0,
			parts: 1,
			geometry: "A-reflow",
			size: () => size,
			capture: () => anchor,
			measure: () => {},
			restore: (restored) => () =>
				initial.complete({ anchor: restored, located: true }),
		},
		() => {},
		() => {},
	);
	layout.resourcesReady(0, 0);
	layout.observe(
		size,
		() => anchor,
		(saved) => persisted.push(saved),
	);
	t.mock.timers.tick(550);
	assert.deepEqual(persisted, [anchor]);
	assert.equal(f.navigation.state.busy, true);
	assert.equal(f.navigation.state.adjacentDisabled, true);
	load.resolve(chapter("B"));
	assert.equal(await pending, true);
	assert.deepEqual(f.saved, [anchor]);
	assert.equal(f.navigation.state.busy, true);
	f.complete();
	assert.equal(f.navigation.state.busy, false);
});

test("an unavailable accepted adjacent surface releases busy and can finish after retry", async () => {
	const f = fixture();
	assert.equal(await f.navigate({ type: "adjacent", direction: "next" }), true);
	assert.equal(f.navigation.state.busy, true);
	const accepted = f.presentations.length - 1;
	f.setUnavailable(true);
	assert.equal(f.navigation.state.busy, false);
	assert.equal(f.navigation.state.adjacentDisabled, true);
	assert.equal(
		await f.navigate({ type: "adjacent", direction: "next" }),
		false,
	);
	f.setUnavailable(false);
	assert.equal(f.presentations.length, accepted + 1);
	assert.equal(f.navigation.state.adjacentDisabled, true);
	f.complete(accepted);
	assert.equal(f.navigation.state.busy, false);
	assert.equal(f.navigation.state.adjacentDisabled, false);
	assert.deepEqual(f.navigation.state.origin, position("A"));
});
