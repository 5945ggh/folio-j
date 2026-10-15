import assert from "node:assert/strict";
import test from "node:test";
import { anchorBeforeLayout, PositionQueue } from "./position.ts";
import {
	type LayoutPass,
	ViewportRecovery,
	type ViewportSize,
} from "./viewport.ts";

test("scroll before ResizeObserver preserves pending anchor and rejects premature restore after another viewport change", async () => {
	const recovery = new ViewportRecovery();
	let viewport: ViewportSize = { width: 1280, height: 700 };
	assert.equal(recovery.finish(recovery.begin(viewport), viewport), true);
	type Anchor = { kind: string; part: number; offset: number };
	let pending: Anchor = { kind: "text", part: 1, offset: 895 };
	let DOMAnchor: Anchor = { kind: "image", part: 0, offset: 0 };
	let samples = 0;
	const sampled: Anchor[] = [];
	const events = new EventTarget();
	let pass: LayoutPass | null = null;
	const capture = () => {
		if (!recovery.canSample(viewport)) return null;
		samples++;
		return DOMAnchor;
	};
	// These events use the production recovery controller and enqueue path, with DOM sampling injected.
	events.addEventListener("scroll", () => {
		const anchor = recovery.observe(viewport, capture);
		if (anchor) {
			pending = anchor;
			sampled.push(anchor);
		}
	});
	events.addEventListener("resize-observer", () => {
		pass = recovery.begin(viewport);
	});
	viewport = { width: 570, height: 700 };
	events.dispatchEvent(new Event("scroll"));
	assert.equal(recovery.restoring, true);
	assert.equal(samples, 0);
	assert.equal(pending.offset, 895);
	events.dispatchEvent(new Event("resize-observer"));
	assert.ok(pass);
	// The window changes again before its ResizeObserver callback has run.
	viewport = { width: 1280, height: 700 };
	assert.equal(recovery.finish(pass, viewport), false);
	events.dispatchEvent(new Event("scroll"));
	assert.equal(samples, 0);
	assert.equal(pending.part, 1);
	const writes: Anchor[] = [];
	const queue = new PositionQueue<Anchor>(
		10,
		async (anchor, revision) => {
			writes.push(anchor);
			return revision + 1;
		},
		() => {},
	);
	const leaving = anchorBeforeLayout(recovery.restoring, pending, capture);
	assert.ok(leaving);
	queue.enqueue(leaving);
	await queue.flush();
	assert.deepEqual(writes, [{ kind: "text", part: 1, offset: 895 }]);
	assert.equal(queue.revision, 11);
	events.dispatchEvent(new Event("resize-observer"));
	assert.ok(pass);
	assert.equal(recovery.finish(pass, viewport), true);
	DOMAnchor = { kind: "text", part: 1, offset: 900 };
	events.dispatchEvent(new Event("scroll"));
	assert.equal(samples, 1);
	assert.deepEqual(sampled, [DOMAnchor]);
});

test("scheduled target size is not a stable sampling baseline until completed restoration", () => {
	const recovery = new ViewportRecovery();
	const initial = { width: 900, height: 600 };
	recovery.finish(recovery.begin(initial), initial);
	const resized = { width: 570, height: 600 };
	const stale = recovery.begin(resized);
	assert.equal(recovery.canSample(resized), false);
	const latest = recovery.begin({ width: 800, height: 600 });
	assert.equal(recovery.finish(stale, resized), false);
	assert.equal(recovery.canSample(resized), false);
	assert.equal(recovery.finish(latest, { width: 800, height: 600 }), true);
	assert.equal(recovery.canSample({ width: 800, height: 600 }), true);
});
