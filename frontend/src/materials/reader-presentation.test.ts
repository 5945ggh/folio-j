import assert from "node:assert/strict";
import test from "node:test";
import type { Chapter, Position, Settings } from "./api.ts";
import { DEFAULT_BOOK_UI } from "./preferences.ts";
import type { ReaderNavigationDestination } from "./reader-navigation.ts";
import {
	ReaderPresentation,
	type ReaderPresentationState,
	type ReaderRestoreIntent,
} from "./reader-presentation.ts";

type Dependencies = ConstructorParameters<typeof ReaderPresentation>[2];
type FrameLoad = Parameters<Dependencies["frames"]["load"]>;
type Completion = Parameters<ReaderPresentation["present"]>[1];
const size = { width: 760, height: 800 };
const settings: Settings = {
	font_size: 22,
	line_height: 2,
	writing_mode: "horizontal-tb",
};
function position(id = "A", offset = 40): Position {
	return {
		version_id: "v",
		chapter_id: id,
		resource_id: `r-${id}`,
		part_index: 0,
		kind: "text",
		offset,
		at_chapter_end: false,
		settings,
	};
}
function chapter(id = "A"): Chapter {
	return {
		id,
		material_id: "book",
		version_id: "v",
		title: id,
		level: 0,
		resources: [],
		parts: [0, 100].map((start) => ({
			resource_id: `r-${id}`,
			spine_index: 0,
			start,
			end: start + 100,
			leaf_start: start,
			leaf_end: start + 1,
			html: "<p>本文</p>",
		})),
	};
}
function destination(id: string, offset = 60): ReaderNavigationDestination {
	const data = chapter(id);
	const part = data.parts[0];
	assert.ok(part);
	return {
		target: position(id, offset),
		chapter: data,
		part,
		beginning: false,
	};
}
function fixture(initialAnchor: Position | null = position()) {
	const events: string[] = [];
	const saved: Position[] = [];
	const snapshots: ReaderPresentationState[] = [];
	const callbacks: {
		index: number;
		generation: number;
		context: FrameLoad[3];
	}[] = [];
	const completed: Parameters<Completion>[0][] = [];
	const restorations: {
		anchor: Position | null;
		intent: ReaderRestoreIntent;
	}[] = [];
	let captured: Position | null = initialAnchor;
	let restoreAllowed = true;
	let motion = false;
	let flushes = 0;
	let pauses = 0;
	let suspensions = 0;
	let stops = 0;
	const writer = {
		enqueue: (anchor: Position) => {
			saved.push(anchor);
		},
		flush: async () => {
			flushes++;
		},
		stop: () => {
			stops++;
		},
	};
	const dependencies: Dependencies = {
		frames: {
			clear: () => {
				events.push("clear");
			},
			load: (index, _element, generation, context) => {
				callbacks.push({ index, generation, context });
			},
			measure: (vertical) => {
				events.push(`measure:${vertical}`);
			},
			presentation: (theme) => {
				events.push(`paint:${theme}`);
			},
			update: (data) => {
				events.push(`update:${data.id}`);
			},
			finishInlineMotion: () => {
				events.push("stabilize");
				motion = false;
			},
			get inlineMotionRunning() {
				return motion;
			},
		},
		navigation: {
			suspend: () => {
				suspensions++;
			},
		},
		reading: {
			pause: () => {
				pauses++;
			},
		},
		writer: () => writer,
		changed: (state) => {
			snapshots.push(state);
		},
	};
	const presentation = new ReaderPresentation(
		{
			chapterId: "A",
			settings,
			generation: 0,
			layoutRevision: 0,
		},
		initialAnchor,
		dependencies,
	);
	const capture = () => (presentation.canSample(size) ? captured : null);
	const complete: Completion = (result) => {
		assert.equal(
			presentation.canSample(size),
			true,
			"receipt must follow stable recovery",
		);
		events.push("complete");
		completed.push(result);
	};
	const commit = (
		data = chapter(presentation.state.chapterId),
		theme: "white" | "black" = "white",
		state = presentation.state,
	) =>
		presentation.commit(
			{ state, chapter: data, theme, bookUi: DEFAULT_BOOK_UI },
			{
				size: () => size,
				capture,
				restore: (anchor, intent) => {
					restorations.push({ anchor, intent });
					events.push("restore");
					assert.equal(presentation.canSample(size), false);
					if (!restoreAllowed) return false;
					captured = anchor;
					return {
						located: true,
						afterRestore: () => {
							events.push("afterRestore");
							presentation.observe(size, capture);
						},
					};
				},
			},
		);
	const load = (data = chapter(presentation.state.chapterId)) =>
		data.parts.map((_, index) => {
			presentation.load(
				index,
				{} as HTMLIFrameElement,
				presentation.state.generation,
				{
					chapter: data,
					readingGeneration: "readings",
					readings: undefined,
					current: () => ({
						settings: presentation.state.settings,
						theme: "white",
						bookUi: DEFAULT_BOOK_UI,
					}),
					root: () => null,
					bindFocus: () => undefined,
					key: () => {},
					wheel: () => {},
					touch: () => {},
					image: () => {},
					error: (error) => {
						throw error;
					},
				},
			);
			const callback = callbacks.at(-1);
			assert.ok(callback);
			return () => callback.context.ready(callback.generation, callback.index);
		});
	const attach = () => presentation.present(null, complete, capture);
	const boot = () => {
		presentation.mount();
		presentation.setActive(true);
		attach();
		commit();
		const ready = load();
		for (const notify of ready) notify();
		return ready;
	};
	return {
		presentation,
		events,
		saved,
		snapshots,
		callbacks,
		completed,
		restorations,
		capture,
		complete,
		commit,
		load,
		attach,
		boot,
		setCaptured: (anchor: Position | null) => {
			captured = anchor;
		},
		setRestoreAllowed: (allowed: boolean) => {
			restoreAllowed = allowed;
		},
		setMotion: (running: boolean) => {
			motion = running;
		},
		counts: () => ({ flushes, pauses, suspensions, stops }),
	};
}

test("initial attachment waits for every resource and successful recovery before its receipt", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	f.presentation.mount();
	f.presentation.setActive(true);
	f.attach();
	f.commit();
	const [first, last] = f.load();
	assert.ok(first && last);
	first();
	assert.equal(f.completed.length, 0);
	assert.equal(f.presentation.canSample(size), false);
	assert.equal(f.restorations.length, 0);
	f.setRestoreAllowed(false);
	last();
	assert.equal(f.completed.length, 0);
	assert.equal(f.presentation.canSample(size), false);
	assert.deepEqual(f.restorations.at(-1)?.anchor, position());
	t.mock.timers.tick(1_000);
	assert.deepEqual(f.saved, []);
	f.setRestoreAllowed(true);
	f.presentation.reflow();
	assert.equal(f.completed.length, 1);
	assert.deepEqual(f.completed[0]?.anchor, position());
	assert.equal(f.restorations.at(-1)?.intent.initialPresentation, true);
	assert.deepEqual(f.events.slice(-3), ["restore", "complete", "afterRestore"]);
	t.mock.timers.tick(550);
	assert.deepEqual(f.saved, [position()]);
});

test("stable reattachment reuses ready resources and captures the current reading location", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	f.boot();
	f.setCaptured(position("A", 75));
	const generation = f.presentation.state.generation;
	f.attach();
	assert.equal(f.presentation.canSample(size), false);
	f.commit();
	assert.equal(f.presentation.state.generation, generation);
	assert.equal(f.callbacks.length, 2);
	assert.equal(f.completed.length, 2);
	assert.deepEqual(f.completed.at(-1)?.anchor, position("A", 75));
	assert.equal(f.restorations.at(-1)?.intent.initialPresentation, false);
	assert.equal(f.events.includes("clear"), false);
});

test("same-chapter jumps reuse resources while chapter replacement and retry reject late generations", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	const oldReady = f.boot();
	const initialGeneration = f.presentation.state.generation;
	f.presentation.present(destination("A", 80), f.complete, f.capture);
	f.commit();
	assert.equal(f.presentation.state.generation, initialGeneration);
	assert.deepEqual(f.completed.at(-1)?.anchor, position("A", 80));
	const next = destination("B");
	f.presentation.present(next, f.complete, f.capture);
	assert.equal(f.presentation.state.generation, initialGeneration + 1);
	f.commit(next.chapter);
	for (const notify of oldReady) notify();
	assert.equal(f.completed.length, 2);
	const replacedReady = f.load(next.chapter);
	replacedReady[0]?.();
	f.presentation.retry();
	assert.equal(f.presentation.state.generation, initialGeneration + 2);
	f.commit(next.chapter);
	for (const notify of replacedReady) notify();
	assert.equal(f.completed.length, 2);
	assert.equal(f.presentation.canSample(size), false);
	const currentReady = f.load(next.chapter);
	for (const notify of currentReady) notify();
	assert.equal(f.completed.length, 3);
	assert.deepEqual(f.completed.at(-1)?.anchor, next.target);
	assert.equal(f.events.filter((event) => event === "clear").length, 2);
});

test("repeating unchanged settings still reflows, whereas theme-only commits preserve inline motion", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	f.boot();
	const revision = f.presentation.state.layoutRevision;
	f.presentation.change(settings, f.capture);
	assert.equal(f.presentation.state.layoutRevision, revision + 1);
	assert.equal(f.presentation.canSample(size), false);
	f.events.length = 0;
	f.commit();
	assert.deepEqual(f.events.slice(0, 4), [
		"stabilize",
		"update:A",
		"measure:false",
		"restore",
	]);
	assert.equal(f.presentation.canSample(size), true);
	f.setMotion(true);
	f.events.length = 0;
	const pauses = f.counts().pauses;
	f.commit(undefined, "black");
	assert.deepEqual(f.events, ["paint:black"]);
	assert.equal(f.counts().pauses, pauses);
	assert.equal(
		f.presentation.canSample(size),
		false,
		"paint-only commit must preserve active motion",
	);
	assert.equal(
		f.presentation.observe(size, () => assert.fail("sampled during motion")),
		null,
	);
});

test("ordinary inline reflow measures and restores without settling ongoing motion", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	f.boot();
	f.setMotion(true);
	f.events.length = 0;
	f.presentation.reflow(() => {
		f.events.push("inline mutation");
	});
	assert.deepEqual(f.events, [
		"inline mutation",
		"measure:false",
		"restore",
		"afterRestore",
	]);
	assert.equal(f.presentation.canSample(size), false);
	f.setMotion(false);
	assert.equal(f.presentation.canSample(size), true);
});

test("a stale render cannot commit or settle motion for a newer accepted destination", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	f.boot();
	const oldState = f.presentation.state;
	f.presentation.present(destination("B"), f.complete, f.capture);
	f.events.length = 0;
	f.commit(chapter("A"), "white", oldState);
	f.commit(chapter("A"));
	assert.deepEqual(f.events, []);
	assert.equal(f.presentation.canSample(size), false);
	assert.equal(f.completed.length, 1);
});

test("suspension suppresses late ready saves and resume retains resource readiness", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	f.boot();
	const next = destination("B");
	f.presentation.present(next, f.complete, f.capture);
	f.commit(next.chapter);
	const [first, last] = f.load(next.chapter);
	assert.ok(first && last);
	first();
	f.presentation.setActive(false);
	assert.deepEqual(f.saved, [position()]);
	const savedBeforeLate = f.saved.length;
	last();
	t.mock.timers.tick(1_000);
	assert.equal(f.saved.length, savedBeforeLate);
	assert.equal(f.completed.length, 1);
	assert.equal(f.presentation.canSample(size), false);
	assert.equal(f.counts().suspensions, 1);
	f.presentation.setActive(true);
	f.attach();
	f.commit(next.chapter);
	assert.equal(
		f.callbacks.length,
		4,
		"resume should not reload retained iframe resources",
	);
	assert.equal(f.presentation.canSample(size), true);
	assert.equal(f.completed.length, 2);
	assert.deepEqual(f.completed.at(-1)?.anchor, next.target);
});

test("a pending physical beginning survives suspension and belongs only to the resumed receipt", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	f.boot();
	const next = { ...destination("B", 0), beginning: true };
	next.part.html = '<img data-epub-image="7"><p>本文</p>';
	let oldCompletions = 0;
	let resumedCompletions = 0;
	f.presentation.present(
		next,
		() => {
			oldCompletions++;
		},
		f.capture,
	);
	f.commit(next.chapter);
	const [first, last] = f.load(next.chapter);
	assert.ok(first && last);
	first();
	f.presentation.setActive(false);
	f.presentation.setActive(true);
	f.presentation.present(
		null,
		(result) => {
			resumedCompletions++;
			f.complete(result);
		},
		f.capture,
	);
	f.commit(next.chapter);
	assert.equal(resumedCompletions, 0);
	f.setRestoreAllowed(false);
	last();
	assert.equal(f.restorations.at(-1)?.intent.beginning, true);
	assert.equal(
		resumedCompletions,
		0,
		"failed recovery must retain the beginning intent and receipt",
	);
	f.setRestoreAllowed(true);
	f.presentation.reflow();
	assert.equal(f.restorations.at(-1)?.intent.beginning, true);
	assert.equal(oldCompletions, 0);
	assert.equal(resumedCompletions, 1);
	assert.deepEqual(f.completed.at(-1)?.anchor, next.target);
	f.presentation.reflow();
	last();
	assert.equal(f.restorations.at(-1)?.intent.beginning, false);
	assert.equal(oldCompletions, 0);
	assert.equal(
		resumedCompletions,
		1,
		"ordinary reflow and repeated ready must not deliver the receipt again",
	);
});

test("StrictMode effect replay cancels delayed frame disposal; actual unmount releases once", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	f.boot();
	f.presentation.unmount();
	f.presentation.mount();
	f.presentation.setActive(true);
	f.attach();
	f.commit();
	t.mock.timers.tick(0);
	assert.equal(f.events.includes("clear"), false);
	assert.equal(f.callbacks.length, 2);
	assert.equal(f.presentation.canSample(size), true);
	f.presentation.unmount(true);
	t.mock.timers.tick(0);
	assert.equal(f.events.filter((event) => event === "clear").length, 1);
	assert.equal(f.counts().stops, 1);
	assert.equal(f.presentation.canSample(size), false);
	const saved = [...f.saved];
	for (const callback of f.callbacks)
		callback.context.ready(callback.generation, callback.index);
	t.mock.timers.tick(1_000);
	assert.deepEqual(f.saved, saved);
});

test("discarding a mounted reader stops its queue without flushing or delayed saves", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	const ready = f.boot();
	f.presentation.unmount(true);
	assert.deepEqual(f.saved, []);
	assert.equal(f.counts().stops, 1);
	assert.equal(f.counts().flushes, 0);
	for (const notify of ready) notify();
	t.mock.timers.tick(1_000);
	assert.deepEqual(f.saved, []);
	assert.equal(f.completed.length, 1);
	assert.equal(f.events.filter((event) => event === "clear").length, 1);
	assert.equal(f.presentation.canSample(size), false);
});

test("checkpoint persists only successfully presented content, never an initial or pending destination", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	f.presentation.mount();
	f.presentation.setActive(true);
	f.attach();
	f.commit();
	f.presentation.checkpoint(() => position("A", 99));
	assert.deepEqual(f.saved, []);
	for (const notify of f.load()) notify();
	assert.equal(f.presentation.canSample(size), true);
	f.presentation.present(destination("B"), f.complete, f.capture);
	f.commit(chapter("B"));
	f.presentation.checkpoint(() => position("B", 60));
	assert.deepEqual(f.saved, [position()]);
	assert.deepEqual(f.presentation.presentedAnchor(), position());
	t.mock.timers.tick(1_000);
	assert.deepEqual(f.saved, [position()]);
	for (const notify of f.load()) notify();
	assert.deepEqual(
		f.completed.at(-1)?.anchor,
		position("B", 60),
		"saving the previous surface must preserve the pending navigation destination",
	);
});

test("checkpoint preserves an accepted same-chapter jump before its render commits", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	f.boot();
	const next = destination("A", 80);
	f.presentation.present(next, f.complete, f.capture);
	f.presentation.checkpoint(() => next.target);
	assert.deepEqual(f.saved, [position()]);
	f.commit(next.chapter);
	assert.deepEqual(f.completed.at(-1)?.anchor, next.target);
	assert.equal(
		f.callbacks.length,
		2,
		"same-chapter jump retains its ready frames",
	);
});

test("inline reflow passes the accepted anchor through recovery without recapturing", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	f.boot();
	const accepted = position("A", 72);
	let captures = 0;
	f.presentation.reflow(undefined, () => {
		captures++;
		return accepted;
	});
	assert.equal(captures, 1);
	assert.deepEqual(f.restorations.at(-1)?.anchor, accepted);
	assert.equal(f.presentation.canSample(size), true);
	f.presentation.present(destination("A", 88), f.complete, f.capture);
	f.presentation.reflow(undefined, () => {
		assert.fail("an unresolved destination must retain its pending anchor");
	});
	assert.equal(f.presentation.canSample(size), false);
	f.commit();
	assert.equal(f.restorations.at(-1)?.anchor?.offset, 88);
});
