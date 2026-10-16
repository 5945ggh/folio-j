import assert from "node:assert/strict";
import test from "node:test";
import { textAnchorRect, textSamplingTarget } from "./dom.ts";
import { anchorBeforeLayout, PositionQueue } from "./position.ts";
import { fitReaderImage } from "./presentation.ts";
import {
	type LayoutPass,
	readingViewport,
	ViewportRecovery,
	type ViewportSize,
} from "./viewport.ts";

test("overlay gutters keep restored text below the title and page steps inside readable content", () => {
	const root = {
		clientWidth: 760,
		clientHeight: 800,
		getBoundingClientRect: () => ({
			top: 0,
			bottom: 800,
			left: 20,
			right: 780,
		}),
	} as HTMLElement;
	const view = readingViewport(root, {
		paddingTop: "82px",
		paddingBottom: "80px",
	});
	assert.equal(view.top, 82);
	assert.equal(view.bottom, 720);
	assert.ok(view.height * 0.85 < view.bottom - view.top);
	// Restoring a line from a later page and sampling it again use the same safe edge.
	const base = { top: 1200, bottom: 1224, left: 0, right: 24 };
	const anchor = textAnchorRect(base, 20);
	const scroll = anchor.top - view.top;
	assert.equal(textSamplingTarget(view.top + scroll, 20, false), base.top);
	assert.equal(base.top - scroll, 102);
	// A full-page image must fit between the two overlays, not in the outer scroll box.
	assert.deepEqual(
		fitReaderImage(
			{ width: 600, height: 1000 },
			{ width: 600, height: 1000 },
			view,
		),
		{ width: 382.8, height: 638 },
	);
});

test("vertical viewport already reserves each column's toolbar clearance", () => {
	const root = {
		clientWidth: 760,
		clientHeight: 638,
		getBoundingClientRect: () => ({
			top: 82,
			bottom: 720,
			left: 20,
			right: 780,
		}),
	} as HTMLElement;
	const view = readingViewport(root, {
		paddingTop: "0px",
		paddingBottom: "0px",
	});
	assert.equal(view.right, 780);
	assert.equal(view.height, 638);
	assert.equal(view.top, 82);
	assert.equal(view.bottom, 720);
});

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
