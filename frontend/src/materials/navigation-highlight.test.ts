import assert from "node:assert/strict";
import test from "node:test";
import { NavigationHighlightLifetime } from "./navigation-highlight.ts";

function fixture() {
	let expired = 0;
	const timers: { callback: () => void; delay: number; cancelled: boolean }[] =
		[];
	const lifetime = new NavigationHighlightLifetime(
		() => expired++,
		(callback, delay) => {
			const timer = { callback, delay, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
	);
	return { lifetime, timers, expired: () => expired };
}

test("navigation feedback starts its 2.5 second deadline only after stable presentation", () => {
	const f = fixture();
	f.lifetime.presented();
	assert.equal(f.timers.length, 0);
	f.lifetime.replace();
	assert.equal(
		f.timers.length,
		0,
		"loading and failed restoration have no deadline",
	);
	f.lifetime.presented();
	assert.equal(f.timers.length, 1);
	assert.equal(f.timers[0]?.delay, 2500);
	assert.equal(f.expired(), 0);
	f.timers[0]?.callback();
	assert.equal(f.expired(), 1);
	f.timers[0]?.callback();
	f.lifetime.presented();
	assert.equal(f.expired(), 1);
	assert.equal(
		f.timers.length,
		1,
		"expiration cannot revive on a later reflow",
	);
});

test("layout restoration does not extend the current navigation feedback deadline", () => {
	const f = fixture();
	f.lifetime.replace();
	f.lifetime.presented();
	f.lifetime.presented();
	f.lifetime.presented();
	assert.equal(f.timers.length, 1);
	f.timers[0]?.callback();
	assert.equal(f.expired(), 1);
});

test("input cancels pending or presented feedback once and later restoration cannot revive it", () => {
	for (const presented of [false, true]) {
		const f = fixture();
		f.lifetime.replace();
		if (presented) f.lifetime.presented();
		f.lifetime.clear();
		f.lifetime.clear();
		f.lifetime.presented();
		assert.equal(f.expired(), 1);
		assert.equal(f.timers.length, presented ? 1 : 0);
		if (presented) {
			assert.equal(f.timers[0]?.cancelled, true);
			f.timers[0]?.callback();
			assert.equal(f.expired(), 1);
		}
	}
});

test("replacing the target isolates a late old timeout from the newer target", () => {
	const f = fixture();
	f.lifetime.replace();
	f.lifetime.presented();
	f.lifetime.replace();
	assert.equal(f.timers[0]?.cancelled, true);
	f.timers[0]?.callback();
	assert.equal(f.expired(), 0);
	f.lifetime.presented();
	assert.equal(f.timers.length, 2);
	f.timers[0]?.callback();
	assert.equal(f.expired(), 0);
	f.timers[1]?.callback();
	assert.equal(f.expired(), 1);
});

test("teardown cancels callbacks while a subsequent target can receive a fresh deadline", () => {
	const f = fixture();
	f.lifetime.replace();
	f.lifetime.presented();
	f.lifetime.dispose();
	assert.equal(f.timers[0]?.cancelled, true);
	f.timers[0]?.callback();
	f.lifetime.presented();
	assert.equal(f.expired(), 0);
	assert.equal(f.timers.length, 1);
	f.lifetime.replace();
	f.lifetime.presented();
	f.timers[1]?.callback();
	assert.equal(f.expired(), 1);
});

test("the default clock expires only after the full visible interval", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let expired = 0;
	const lifetime = new NavigationHighlightLifetime(() => expired++);
	lifetime.replace();
	t.mock.timers.tick(5000);
	assert.equal(expired, 0);
	lifetime.presented();
	t.mock.timers.tick(2499);
	assert.equal(expired, 0);
	lifetime.presented();
	t.mock.timers.tick(1);
	assert.equal(expired, 1);
});

function fadeFixture(reducedMotion = false) {
	let elapsed = 0;
	let expired = 0;
	const opacity: number[] = [];
	const frames: { callback: () => void; cancelled: boolean }[] = [];
	const timers: (() => void)[] = [];
	const lifetime = new NavigationHighlightLifetime(
		() => expired++,
		(callback) => {
			timers.push(callback);
			return () => {};
		},
		{
			opacity: (value) => opacity.push(value),
			reducedMotion: () => reducedMotion,
			now: () => elapsed,
			frame: (callback) => {
				const pending = { callback, cancelled: false };
				frames.push(pending);
				return () => {
					pending.cancelled = true;
				};
			},
		},
	);
	lifetime.replace();
	lifetime.presented();
	return {
		lifetime,
		timers,
		frames,
		opacity,
		expired: () => expired,
		tick: (time: number) => {
			elapsed = time;
			frames.at(-1)?.callback();
		},
	};
}

test("expiration retains the target through the fade and reflows cannot restart or brighten it", () => {
	const f = fadeFixture();
	f.timers[0]?.();
	assert.equal(f.expired(), 0);
	f.tick(130);
	assert.equal(f.opacity.at(-1), 0.5);
	f.lifetime.presented();
	f.lifetime.clear();
	assert.equal(f.timers.length, 1);
	assert.equal(f.frames.length, 2);
	f.tick(260);
	assert.equal(f.opacity.at(-1), 0);
	assert.equal(f.expired(), 1);
	f.tick(300);
	f.lifetime.presented();
	assert.equal(f.expired(), 1);
	assert.equal(f.timers.length, 1);
});

test("input begins the fade early and stale deadline cannot restart it", () => {
	const f = fadeFixture();
	f.lifetime.clear();
	f.tick(65);
	assert.equal(f.opacity.at(-1), 0.75);
	f.timers[0]?.();
	assert.equal(f.frames.length, 2);
	f.tick(260);
	assert.equal(f.expired(), 1);
});

test("target replacement and teardown isolate cancelled animation callbacks", () => {
	for (const action of ["replace", "dispose"] as const) {
		const f = fadeFixture();
		f.lifetime.clear();
		f.tick(130);
		const staleFrame = f.frames.at(-1);
		f.lifetime[action]();
		assert.equal(staleFrame?.cancelled, true);
		const values = [...f.opacity];
		staleFrame?.callback();
		f.timers[0]?.();
		assert.deepEqual(f.opacity, values);
		assert.equal(f.expired(), 0);
		if (action === "replace") {
			assert.equal(f.opacity.at(-1), 1);
			f.lifetime.presented();
			f.timers[1]?.();
			f.tick(390);
			assert.equal(f.expired(), 1);
		}
	}
});

test("reduced motion and immediate navigation clear skip or interrupt the fade", () => {
	const reduced = fadeFixture(true);
	reduced.timers[0]?.();
	assert.equal(reduced.expired(), 1);
	assert.equal(reduced.frames.length, 0);
	const immediate = fadeFixture();
	immediate.lifetime.clear();
	immediate.tick(130);
	immediate.lifetime.clear(true);
	assert.equal(immediate.expired(), 1);
	assert.equal(immediate.frames.at(-1)?.cancelled, true);
	immediate.tick(260);
	assert.equal(immediate.expired(), 1);
});
