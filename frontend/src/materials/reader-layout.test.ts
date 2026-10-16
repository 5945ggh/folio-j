import assert from "node:assert/strict";
import test from "node:test";
import { ReaderLayout } from "./reader-layout.ts";

const size = { width: 760, height: 800 };
test("saved chapter ends are navigation intents only on the first stable presentation of each generation", () => {
	const anchor = { offset: 800, at_chapter_end: true };
	const layout = new ReaderLayout(anchor);
	const initial: boolean[] = [];
	let canRestore = false;
	const surface = {
		generation: 0,
		parts: 2,
		geometry: "initial",
		size: () => size,
		capture: () => anchor,
		measure: () => {},
		restore: (saved: typeof anchor | null, first: boolean) => {
			assert.deepEqual(saved, anchor);
			initial.push(first);
			return canRestore ? () => {} : (false as const);
		},
	};
	layout.commit(
		surface,
		() => {},
		() => {},
	);
	layout.resourcesReady(0, 0);
	assert.deepEqual(initial, []);
	layout.resourcesReady(0, 1);
	assert.deepEqual(initial, [true]);
	assert.equal(layout.canSample(size), false);
	canRestore = true;
	layout.reflow();
	layout.reflow();
	assert.deepEqual(initial, [true, true, false]);
	layout.commit(
		{ ...surface, geometry: "larger-font" },
		() => {},
		() => {},
	);
	assert.equal(initial.at(-1), false);
	layout.setAnchor(anchor);
	layout.invalidateSurface();
	layout.commit(
		{ ...surface, generation: 1 },
		() => {},
		() => {},
	);
	layout.resourcesReady(1, 0);
	layout.resourcesReady(1, 1);
	assert.deepEqual(initial, [true, true, false, false, true]);
	layout.reflow();
	assert.equal(initial.at(-1), false);
});

function fixture() {
	const layout = new ReaderLayout<number>(600);
	let scroll = 600;
	const events: string[] = [];
	const surface = {
		generation: 0,
		parts: 1,
		geometry: "initial",
		size: () => size,
		capture: () => {
			events.push("capture");
			return layout.canSample(size) ? scroll : null;
		},
		measure: () => {
			events.push("resize");
			scroll = 0;
			assert.equal(layout.canSample(size), false);
		},
		restore: (anchor: number | null) => {
			events.push("restore");
			scroll = anchor ?? 0;
			return () => {
				events.push("restored");
			};
		},
	};
	layout.commit(
		surface,
		() => {},
		() => {},
	);
	layout.resourcesReady(0, 0);
	events.length = 0;
	return { layout, surface, events, scroll: () => scroll };
}
test("protected reflow captures before 1px measurement and restores before sampling", () => {
	const { layout, events, scroll } = fixture();
	layout.reflow();
	assert.deepEqual(events, ["capture", "resize", "restore", "restored"]);
	assert.equal(scroll(), 600);
	assert.equal(layout.canSample(size), true);
});
test("paint-only changes and late readings leave stable geometry unmeasured", () => {
	const { layout, surface, events } = fixture();
	for (let i = 0; i < 3; i++)
		layout.commit(
			{ ...surface },
			() => events.push("paint"),
			() => assert.fail("layout update"),
		);
	assert.deepEqual(events, ["paint", "paint", "paint"]);
	assert.equal(layout.canSample(size), true);
});
test("all current resources ready restore once and ignore stale or repeated completion", () => {
	const { layout, surface, events } = fixture();
	layout.invalidateSurface();
	layout.commit(
		{ ...surface, generation: 1, parts: 2 },
		() => {},
		() => {},
	);
	events.length = 0;
	layout.resourcesReady(0, 0);
	layout.resourcesReady(1, 0);
	assert.deepEqual(events, []);
	layout.resourcesReady(1, 1);
	assert.deepEqual(events, ["resize", "restore", "restored"]);
	layout.resourcesReady(1, 1);
	assert.equal(events.length, 3);
});
test("failed restoration keeps sampling closed", () => {
	const { layout, surface } = fixture();
	assert.throws(() =>
		layout.commit(
			{
				...surface,
				geometry: "changed",
				restore: () => {
					throw new Error("failed");
				},
			},
			() => {},
			() => {},
		),
	);
	assert.equal(layout.canSample(size), false);
});

test("reflow cancels delayed persistence and viewport mismatch preserves the last anchor", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { layout, surface, scroll } = fixture();
	const saved: number[] = [];
	layout.observe(
		size,
		() => 700,
		(anchor) => saved.push(anchor),
	);
	layout.commit(
		{ ...surface, capture: () => 700, geometry: "changed" },
		() => {},
		() => {},
	);
	t.mock.timers.tick(550);
	assert.equal(saved.length, 0);
	assert.equal(scroll(), 700);
	const changed = { width: 570, height: 800 };
	layout.observe(
		changed,
		() => assert.fail("sampled unstable viewport"),
		(anchor) => saved.push(anchor),
	);
	layout.commit(
		{ ...surface, size: () => changed },
		() => {},
		() => {},
	);
	assert.equal(scroll(), 700);
	assert.equal(layout.canSample(changed), true);
});

test("invalidating the surface during restoration cannot reopen sampling", () => {
	const { layout, surface } = fixture();
	layout.commit(
		{
			...surface,
			geometry: "changed",
			restore: () => {
				layout.invalidateSurface();
				return () => {};
			},
		},
		() => {},
		() => {},
	);
	assert.equal(layout.canSample(size), false);
});

test("new generation with the same geometry waits for its own resources", () => {
	const { layout, surface, events } = fixture();
	layout.commit(
		{ ...surface, generation: 1 },
		() => assert.fail("new surface used paint-only path"),
		() => {},
	);
	assert.equal(layout.canSample(size), false);
	events.length = 0;
	layout.resourcesReady(0, 0);
	assert.deepEqual(events, []);
	layout.resourcesReady(1, 0);
	assert.deepEqual(events, ["resize", "restore", "restored"]);
	assert.equal(layout.canSample(size), true);
});

test("unavailable DOM restoration keeps sampling closed until a later successful pass", () => {
	const { layout, surface } = fixture();
	layout.commit(
		{ ...surface, geometry: "new", restore: () => false },
		() => {},
		() => {},
	);
	assert.equal(layout.canSample(size), false);
	layout.commit(
		{ ...surface, geometry: "new" },
		() => {},
		() => {},
	);
	assert.equal(layout.canSample(size), true);
});

test("a committed empty frame set can accept first-load readiness without another React render", () => {
	const layout = new ReaderLayout(42);
	let frames = 0,
		restores = 0;
	layout.commit(
		{
			generation: 0,
			parts: 1,
			geometry: "first",
			size: () => size,
			capture: () => null,
			measure: () => {
				if (frames) assert.equal(layout.canSample(size), false);
			},
			restore: (anchor) => {
				assert.equal(anchor, 42);
				restores++;
				return () => {};
			},
		},
		() => {},
		() => {},
	);
	assert.equal(restores, 0);
	frames = 1;
	layout.resourcesReady(0, 0);
	assert.equal(restores, 1);
	assert.equal(layout.canSample(size), true);
});

test("provisional cross-chapter target never replaces last successfully presented position", () => {
	const { layout, surface } = fixture();
	layout.observe(
		size,
		() => 700,
		() => {},
	);
	layout.setAnchor(42);
	layout.invalidateSurface();
	assert.equal(
		layout.presentedAnchor(() => assert.fail("sampled provisional target")),
		700,
	);
	layout.commit(
		{ ...surface, generation: 1 },
		() => {},
		() => {},
	);
	assert.equal(
		layout.presentedAnchor(() => assert.fail("sampled incomplete surface")),
		700,
	);
	layout.resourcesReady(1, 0);
	layout.observe(
		size,
		() => 42,
		() => {},
	);
	assert.equal(
		layout.presentedAnchor(() => null),
		42,
	);
	layout.cancelSave();
});

test("leaving an initial reader before presentation never persists its restoration target", () => {
	const layout = new ReaderLayout({ revision: 5, progress: 0.8, offset: 80 });
	assert.deepEqual(
		layout.anchor(() => null),
		{ revision: 5, progress: 0.8, offset: 80 },
	);
	assert.equal(
		layout.presentedAnchor(() =>
			assert.fail("sampled unpresented initial surface"),
		),
		null,
	);
	layout.cancelSave();
	assert.equal(
		layout.presentedAnchor(() => null),
		null,
	);
});
